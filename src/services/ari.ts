/**
 * Asterisk ARI / Stasis adapter.
 *
 * Laravel owns the pacing decisions and the database; this process owns the
 * live call. It holds the Stasis WebSocket (which Laravel cannot, being
 * request/response), and when a lead answers it asks Laravel who to bridge
 * to, then wires the two channels together.
 *
 * Call shape:
 *   Laravel originates lead ──► Stasis "lead"
 *      └─ StasisStart ──► ask Laravel ──► agent extension
 *            ├─ none  ──► play notice, hang up (abandoned)
 *            └─ some  ──► create bridge, originate agent ──► Stasis "agent"
 *                              └─ StasisStart ──► add both to bridge
 */

const ARI_BASE = process.env.ASTERISK_ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ASTERISK_ARI_USER || 'mkb_user';
const ARI_PASS = process.env.ASTERISK_ARI_PASSWORD || 'mkb_pass';
const STASIS_APP = process.env.ASTERISK_STASIS_APP || 'mkb-dialer';
const LARAVEL_URL = process.env.LARAVEL_API_URL || 'http://127.0.0.1:8000/api';
const AGENT_RING_TIMEOUT = parseInt(process.env.AGENT_RING_TIMEOUT || '25', 10);

const authHeader = 'Basic ' + Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64');

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** In-flight calls, keyed by attempt id. Rebuilt naturally on reconnect. */
type LiveCall = {
  attemptId: string;
  leadChannelId: string;
  bridgeId?: string;
  agentChannelId?: string;
  agentTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set the moment the agent leg joins the bridge. The no-answer timer keys
   * off this flag rather than off being cleared: an agent on a fast endpoint
   * can answer before the timer variable is even assigned, and a cleared-too-
   * early timer would otherwise fire mid-conversation and drop a live call.
   */
  bridged?: boolean;
};

const calls = new Map<string, LiveCall>();
const channelToAttempt = new Map<string, string>();

async function ari(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ARI_BASE}/ari${path}`, {
    ...init,
    headers: { Authorization: authHeader, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function ariJson<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const res = await ari(path, init);
  if (!res.ok) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Report a call event to Laravel and hand back whatever it decides. */
async function notifyLaravel(payload: Record<string, unknown>, log: Logger): Promise<any> {
  try {
    const res = await fetch(`${LARAVEL_URL}/dialer/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    log.error({ err, payload }, 'Failed to reach Laravel with call event');
    return {};
  }
}

async function getChannelVar(channelId: string, name: string): Promise<string | null> {
  const res = await ariJson<{ value: string }>(`/channels/${channelId}/variable?variable=${encodeURIComponent(name)}`);
  return res?.value || null;
}

async function hangup(channelId: string): Promise<void> {
  await ari(`/channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
}

function cleanup(attemptId: string) {
  const call = calls.get(attemptId);
  if (!call) return;
  if (call.agentTimer) clearTimeout(call.agentTimer);
  channelToAttempt.delete(call.leadChannelId);
  if (call.agentChannelId) channelToAttempt.delete(call.agentChannelId);
  calls.delete(attemptId);
}

/** A lead picked up. Ask Laravel for an agent and bridge, or abandon. */
async function handleLeadAnswered(channelId: string, log: Logger) {
  const attemptId = (await getChannelVar(channelId, 'MKB_ATTEMPT_ID')) || '';
  if (!attemptId) {
    log.warn({ channelId }, 'Lead channel has no MKB_ATTEMPT_ID — hanging up');
    await hangup(channelId);
    return;
  }

  calls.set(attemptId, { attemptId, leadChannelId: channelId });
  channelToAttempt.set(channelId, attemptId);

  // Answer before we go looking for an agent, so the caller hears silence
  // rather than continued ringing while we decide.
  await ari(`/channels/${channelId}/answer`, { method: 'POST' }).catch(() => {});

  const decision = await notifyLaravel(
    { event: 'lead_answered', attempt_id: Number(attemptId), channel_id: channelId },
    log,
  );

  const agentExtension: string | null = decision?.agentExtension ?? null;

  if (!agentExtension) {
    log.warn({ attemptId }, 'No agent available — abandoning call');
    await ari(`/channels/${channelId}/play?media=sound:vm-goodbye`, { method: 'POST' }).catch(() => {});
    setTimeout(() => hangup(channelId), 2500);
    return;
  }

  // Mixing bridge holds the lead while the agent's phone rings.
  const bridge = await ariJson<{ id: string }>(`/bridges?type=mixing`, { method: 'POST' });
  if (!bridge?.id) {
    log.error({ attemptId }, 'Could not create bridge — hanging up lead');
    await hangup(channelId);
    return;
  }

  const call = calls.get(attemptId)!;
  call.bridgeId = bridge.id;

  await ari(`/bridges/${bridge.id}/addChannel?channel=${channelId}`, { method: 'POST' }).catch(() => {});

  // Ring the agent into the same Stasis app. A bare extension means a
  // registered softphone; an endpoint containing "/" is passed through
  // verbatim, which is how a remote agent on their mobile is supported.
  const agentEndpoint = agentExtension.includes('/') ? agentExtension : `PJSIP/${agentExtension}`;

  const agentChannel = await ariJson<{ id: string }>(`/channels`, {
    method: 'POST',
    body: JSON.stringify({
      endpoint: agentEndpoint,
      app: STASIS_APP,
      appArgs: 'agent',
      callerId: decision?.callerId || 'MKB Dialer',
      timeout: AGENT_RING_TIMEOUT,
      variables: { MKB_ATTEMPT_ID: attemptId, MKB_ROLE: 'agent' },
    }),
  });

  if (!agentChannel?.id) {
    log.error({ attemptId, agentEndpoint }, 'Agent originate failed — abandoning');
    await notifyLaravel({ event: 'ended', attempt_id: Number(attemptId), cause: 'agent-originate-failed' }, log);
    await hangup(channelId);
    cleanup(attemptId);
    return;
  }

  call.agentChannelId = agentChannel.id;
  channelToAttempt.set(agentChannel.id, attemptId);

  await notifyLaravel(
    { event: 'agent_ringing', attempt_id: Number(attemptId), agent_channel_id: agentChannel.id },
    log,
  );

  // If the agent never picks up, don't strand the lead in a silent bridge.
  const timer = setTimeout(async () => {
    const current = calls.get(attemptId);
    if (!current || current.bridged) return; // agent made it in — nothing to do
    log.warn({ attemptId }, 'Agent did not answer in time — releasing lead');
    await notifyLaravel({ event: 'ended', attempt_id: Number(attemptId), cause: 'agent-no-answer' }, log);
    await hangup(channelId);
    if (current.agentChannelId) await hangup(current.agentChannelId);
    cleanup(attemptId);
  }, (AGENT_RING_TIMEOUT + 5) * 1000);

  // The agent may already have answered while we were awaiting above; if so
  // the bridged flag is set and we must not arm the timer at all.
  if (call.bridged) clearTimeout(timer);
  else call.agentTimer = timer;
}

/** The agent's phone answered — drop them into the bridge with the lead. */
async function handleAgentAnswered(channelId: string, log: Logger) {
  const attemptId = (await getChannelVar(channelId, 'MKB_ATTEMPT_ID')) || '';
  const call = attemptId ? calls.get(attemptId) : undefined;

  if (!call?.bridgeId) {
    log.warn({ channelId, attemptId }, 'Agent channel with no live bridge — hanging up');
    await hangup(channelId);
    return;
  }

  // Mark bridged before any await, so a timer armed concurrently sees it.
  call.bridged = true;
  if (call.agentTimer) {
    clearTimeout(call.agentTimer);
    call.agentTimer = undefined;
  }

  await ari(`/bridges/${call.bridgeId}/addChannel?channel=${channelId}`, { method: 'POST' }).catch(() => {});

  await notifyLaravel(
    {
      event: 'bridged',
      attempt_id: Number(attemptId),
      agent_channel_id: channelId,
      bridge_id: call.bridgeId,
    },
    log,
  );

  log.info({ attemptId }, 'Lead bridged to agent');
}

/** Either leg hung up: tear down the other and close the attempt. */
async function handleChannelGone(channelId: string, cause: string | undefined, log: Logger) {
  const attemptId = channelToAttempt.get(channelId);
  if (!attemptId) return;

  const call = calls.get(attemptId);
  if (!call) return;

  const other = channelId === call.leadChannelId ? call.agentChannelId : call.leadChannelId;

  await notifyLaravel(
    { event: 'ended', attempt_id: Number(attemptId), channel_id: channelId, cause: cause || null },
    log,
  );

  if (other) await hangup(other);
  if (call.bridgeId) await ari(`/bridges/${call.bridgeId}`, { method: 'DELETE' }).catch(() => {});

  cleanup(attemptId);
}

/** Connect the Stasis WebSocket, retrying forever with backoff. */
export function startAriListener(log: Logger) {
  let attempt = 0;

  const connect = () => {
    const wsUrl =
      ARI_BASE.replace(/^http/, 'ws') +
      `/ari/events?api_key=${encodeURIComponent(ARI_USER)}:${encodeURIComponent(ARI_PASS)}` +
      `&app=${encodeURIComponent(STASIS_APP)}&subscribeAll=true`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      log.error({ err }, 'Could not open ARI websocket');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempt = 0;
      log.info({ app: STASIS_APP }, '🔌 Stasis connected to Asterisk');
    };

    ws.onmessage = async (raw: MessageEvent) => {
      let evt: any;
      try {
        evt = JSON.parse(typeof raw.data === 'string' ? raw.data : String(raw.data));
      } catch {
        return;
      }

      try {
        switch (evt.type) {
          case 'StasisStart': {
            const role = Array.isArray(evt.args) ? evt.args[0] : undefined;
            const channelId = evt.channel?.id;
            if (!channelId) return;
            if (role === 'agent') await handleAgentAnswered(channelId, log);
            else await handleLeadAnswered(channelId, log);
            break;
          }
          case 'ChannelDestroyed':
          case 'StasisEnd': {
            const channelId = evt.channel?.id;
            if (channelId) {
              await handleChannelGone(channelId, evt.cause_txt || evt.cause, log);
            }
            break;
          }
        }
      } catch (err) {
        log.error({ err, type: evt?.type }, 'Error handling Stasis event');
      }
    };

    ws.onclose = () => {
      log.warn({}, 'Stasis websocket closed — reconnecting');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  };

  const scheduleReconnect = () => {
    attempt += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    setTimeout(connect, delay);
  };

  connect();
}

export const _internal = { calls, channelToAttempt };
