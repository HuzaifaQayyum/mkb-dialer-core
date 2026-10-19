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
const TRUNK = process.env.ASTERISK_TRUNK || 'telnyx-trunk';
const SIP_DOMAIN = process.env.TELNYX_SIP_DOMAIN || 'sip.telnyx.com';
const TEST_ENDPOINT = process.env.ASTERISK_TEST_ENDPOINT || '';

function outboundEndpoint(dialString: string): string {
  return TEST_ENDPOINT || `PJSIP/${TRUNK}/sip:${dialString}@${SIP_DOMAIN}`;
}
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
  ringbackPlaybackId?: string;
  recordingName?: string;
  thirdPartyChannelId?: string;
  retiredChannelIds?: Set<string>;
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

const RECORDING_FORMAT = process.env.RECORDING_FORMAT || 'wav';
const RECORDING_NOTICE = process.env.RECORDING_NOTICE ?? 'sound:custom/recording-notice';

/**
 * Play the "this call may be recorded" notice to the party who answered,
 * and wait for it to finish before bridging. Many jurisdictions require the
 * announcement to precede any recorded audio, so this deliberately blocks
 * the bridge rather than playing over the start of the conversation.
 */
async function playRecordingNotice(channelId: string, log: Logger) {
  if (!RECORDING_ENABLED || !RECORDING_NOTICE) return;

  const pb = await ariJson<{ id: string }>(
    `/channels/${channelId}/play?media=${encodeURIComponent(RECORDING_NOTICE)}`,
    { method: 'POST' },
  ).catch(() => null);

  if (!pb?.id) {
    log.warn({ channelId }, 'Recording notice failed to play');
    return;
  }

  // Poll the playback rather than guessing a duration; a missing playback
  // means it finished. Capped so a stuck prompt cannot hold a call open.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const still = await ariJson<{ state: string }>(`/playbacks/${pb.id}`).catch(() => null);
    if (!still || still.state === 'done' || still.state === 'failed') return;
  }
  await ari(`/playbacks/${pb.id}`, { method: 'DELETE' }).catch(() => {});
}
const RECORDING_ENABLED = process.env.RECORDING_ENABLED !== 'false';

/**
 * Record the mixed bridge audio, not a single channel, so a third party
 * pulled into a 3-way and an agent swapped in by a transfer are both
 * captured in the same file.
 */
async function startBridgeRecording(attemptId: string, bridgeId: string, log: Logger) {
  if (!RECORDING_ENABLED) return;
  const call = calls.get(attemptId);
  if (call?.recordingName) return;

  const name = `call-${attemptId}-${Date.now()}`;
  const qs = new URLSearchParams({
    name,
    format: RECORDING_FORMAT,
    ifExists: 'overwrite',
    beep: 'false',
    terminateOn: 'none',
  }).toString();

  const res = await ari(`/bridges/${bridgeId}/record?${qs}`, { method: 'POST' });
  if (!res.ok) {
    log.warn({ attemptId, bridgeId, status: res.status }, 'Could not start recording');
    await notifyLaravel(
      { event: 'recording', attempt_id: Number(attemptId), recording_status: 'failed' },
      log,
    );
    return;
  }

  if (call) call.recordingName = name;
  await notifyLaravel(
    {
      event: 'recording',
      attempt_id: Number(attemptId),
      recording_name: name,
      recording_format: RECORDING_FORMAT,
      recording_status: 'recording',
    },
    log,
  );
  log.info({ attemptId, name }, 'Recording started');
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
  if (call.thirdPartyChannelId) channelToAttempt.delete(call.thirdPartyChannelId);
  call.retiredChannelIds?.forEach((c) => channelToAttempt.delete(c));
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

  await playRecordingNotice(channelId, log);

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

  await startBridgeRecording(attemptId, call.bridgeId, log);
  log.info({ attemptId }, 'Lead bridged to agent');
}

/**
 * An agent dialed a PSTN number from their phone.
 *
 * The dialplan hands us the agent's channel instead of running Dial(), so the
 * call lands in a bridge we own and can later add a third party to or hand to
 * another agent. Laravel registers the attempt and tells us which caller ID
 * to present.
 */
async function handleAgentDial(
  channelId: string,
  destination: string,
  endpointArg: string,
  channelName: string,
  log: Logger,
) {
  // The dialplan passes ${CHANNEL(endpoint)}; fall back to the channel name
  // ("PJSIP/1001-00000007" -> "1001") only if that is unavailable.
  const extension = endpointArg || (channelName.split('/')[1] || '').split('-')[0];

  const reg = await notifyLaravel(
    {
      event: 'agent_dial_start',
      agent_extension: extension,
      destination,
      channel_id: channelId,
    },
    log,
  );

  const attemptId: string | null = reg?.attemptId ?? null;
  if (!attemptId) {
    log.warn({ channelId, extension, destination, reg }, 'Laravel would not register this call');
    await hangup(channelId);
    return;
  }

  const bridge = await ariJson<{ id: string }>(`/bridges?type=mixing`, { method: 'POST' });
  if (!bridge?.id) {
    log.error({ attemptId }, 'Could not create bridge for agent dial');
    await hangup(channelId);
    return;
  }

  // The agent leg is the "agent" side; the PSTN leg becomes the "lead" side.
  calls.set(attemptId, {
    attemptId,
    leadChannelId: '',
    agentChannelId: channelId,
    bridgeId: bridge.id,
  });
  channelToAttempt.set(channelId, attemptId);

  // Send a ringing indication rather than answering. Answering here puts a
  // 200 OK on the agent's leg, so their browser reports the call as connected
  // and the UI shows "Live" while the far end is still ringing — or has
  // already failed. The agent leg is only answered once the far end answers.
  await ari(`/channels/${channelId}/ring`, { method: 'POST' }).catch(() => {});

  const pstn = await ariJson<{ id: string }>(`/channels`, {
    method: 'POST',
    body: JSON.stringify({
      endpoint: outboundEndpoint(reg.dialString ?? destination),
      app: STASIS_APP,
      appArgs: 'outbound-leg',
      callerId: reg.callerId ?? '',
      timeout: 45,
      variables: { MKB_ATTEMPT_ID: attemptId, MKB_BRIDGE_ID: bridge.id, MKB_ROLE: 'outbound-leg' },
    }),
  });

  if (!pstn?.id) {
    log.error({ attemptId, destination }, 'Carrier refused the agent-dialed call');
    await notifyLaravel({ event: 'ended', attempt_id: Number(attemptId), cause: 'originate-rejected' }, log);
    await hangup(channelId);
    cleanup(attemptId);
    return;
  }

  const call = calls.get(attemptId)!;
  call.leadChannelId = pstn.id;
  channelToAttempt.set(pstn.id, attemptId);
  log.info({ attemptId, destination }, 'Agent dial: ringing the far end');
}

/** The PSTN side of an agent-dialed call answered — bridge the two. */
async function handleOutboundLegAnswered(channelId: string, log: Logger) {
  const attemptId = (await getChannelVar(channelId, 'MKB_ATTEMPT_ID')) || '';
  const bridgeId =
    (await getChannelVar(channelId, 'MKB_BRIDGE_ID')) || calls.get(attemptId)?.bridgeId || '';

  if (!bridgeId) {
    log.warn({ channelId, attemptId }, 'Outbound leg with no bridge — hanging up');
    await hangup(channelId);
    return;
  }

  await playRecordingNotice(channelId, log);

  const call = calls.get(attemptId);

  if (call?.agentChannelId) {
    // Stop the ringing indication and answer the agent's leg only now, so
    // their browser flips to connected at the same moment the far end does.
    await ari(`/channels/${call.agentChannelId}/ring`, { method: 'DELETE' }).catch(() => {});
    await ari(`/channels/${call.agentChannelId}/answer`, { method: 'POST' }).catch(() => {});
    call.bridged = true;
    const joinAgent = await ari(
      `/bridges/${bridgeId}/addChannel?channel=${call.agentChannelId}`,
      { method: 'POST' },
    );
    if (!joinAgent.ok) {
      log.error({ attemptId, status: joinAgent.status }, 'Agent leg failed to join bridge');
    }
  }

  const joinPstn = await ari(`/bridges/${bridgeId}/addChannel?channel=${channelId}`, { method: 'POST' });
  if (!joinPstn.ok) {
    log.error({ attemptId, status: joinPstn.status }, 'PSTN leg failed to join bridge');
  }

  await notifyLaravel(
    {
      event: 'bridged',
      attempt_id: Number(attemptId),
      agent_channel_id: call?.agentChannelId ?? null,
      bridge_id: bridgeId,
    },
    log,
  );

  await startBridgeRecording(attemptId, bridgeId, log);
  log.info({ attemptId }, 'Agent dial connected');
}

/**
 * A third party (3-way) or a receiving agent (transfer) answered. Both just
 * need to join the bridge the call is already in; Laravel passes the bridge id
 * on the channel so this works even for a call this process did not set up
 * (after a restart, say) and whose id is no longer in the in-memory map.
 */
async function handleJoinBridge(channelId: string, role: 'threeway' | 'transfer', log: Logger) {
  const attemptId = (await getChannelVar(channelId, 'MKB_ATTEMPT_ID')) || '';
  const bridgeId =
    (await getChannelVar(channelId, 'MKB_BRIDGE_ID')) || calls.get(attemptId)?.bridgeId || '';

  if (!bridgeId) {
    log.warn({ channelId, attemptId, role }, 'No bridge to join — hanging up');
    await hangup(channelId);
    return;
  }

  const res = await ari(`/bridges/${bridgeId}/addChannel?channel=${channelId}`, { method: 'POST' });
  if (!res.ok) {
    log.error({ channelId, bridgeId, role, status: res.status }, 'Could not join bridge');
    await hangup(channelId);
    return;
  }

  if (attemptId) channelToAttempt.set(channelId, attemptId);

  if (role === 'transfer') {
    // The handing-off agent leaves only once the receiving agent is in, so
    // the customer is never left alone on the bridge.
    const drop = (await getChannelVar(channelId, 'MKB_DROP_CHANNEL')) || '';
    const call = calls.get(attemptId);
    if (call) {
      call.agentChannelId = channelId;
      call.bridged = true;
    }
    if (drop) {
      // Keep the mapping and mark it retired, so its teardown is recognised
      // as an expected hand-off rather than the customer hanging up.
      if (call) {
        call.retiredChannelIds = call.retiredChannelIds ?? new Set();
        call.retiredChannelIds.add(drop);
      }
      await hangup(drop);
    }
    await notifyLaravel(
      { event: 'bridged', attempt_id: Number(attemptId), agent_channel_id: channelId, bridge_id: bridgeId },
      log,
    );
    log.info({ attemptId }, 'Call transferred to new agent');
  } else {
    const call = calls.get(attemptId);
    if (call) call.thirdPartyChannelId = channelId;
    log.info({ attemptId }, 'Third party joined the call');
  }
}

/** Either leg hung up: tear down the other and close the attempt. */
async function handleChannelGone(channelId: string, cause: string | undefined, log: Logger) {
  const attemptId = channelToAttempt.get(channelId);

  // A lead that never answers is destroyed before it ever enters Stasis, so
  // this process has no mapping for it. Report it by channel id anyway —
  // Laravel resolves that to the attempt. Without this the call sits
  // "ringing" until the 120s reaper guesses at it, losing the real cause.
  if (!attemptId) {
    await notifyLaravel(
      { event: 'ended', channel_id: channelId, cause: cause || null },
      log,
    );
    return;
  }
  log.info({ attemptId, channelId, cause }, 'Channel gone');

  const call = calls.get(attemptId);

  // No in-memory state (already cleaned up, or core restarted mid-call) still
  // has to close the record. Returning here silently left calls stuck at
  // "bridged" forever with a zero duration.
  if (!call) {
    channelToAttempt.delete(channelId);
    await notifyLaravel(
      { event: 'ended', attempt_id: Number(attemptId), channel_id: channelId, cause: cause || null },
      log,
    );
    return;
  }

  // A retired agent leg (handed off by a transfer) is expected to disappear
  // and must not be mistaken for the customer hanging up.
  if (call.retiredChannelIds?.has(channelId)) {
    call.retiredChannelIds.delete(channelId);
    channelToAttempt.delete(channelId);
    log.info({ attemptId, channelId }, 'Retired leg gone; call continues');
    return;
  }

  // Only the channel we actually dialled as the third party counts as one.
  // Matching on "not lead and not agent" misfired after a transfer, because
  // agentChannelId had already been reassigned to the receiving agent.
  if (call.thirdPartyChannelId && channelId === call.thirdPartyChannelId) {
    call.thirdPartyChannelId = undefined;
    channelToAttempt.delete(channelId);
    await notifyLaravel(
      { event: 'third_party_left', attempt_id: Number(attemptId), channel_id: channelId },
      log,
    );
    log.info({ attemptId }, 'Third party left; call continues');
    return;
  }

  if (channelId !== call.leadChannelId && channelId !== call.agentChannelId) {
    channelToAttempt.delete(channelId);
    log.info({ attemptId, channelId }, 'Unknown leg gone; ignoring');
    return;
  }

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
            else if (role === 'agent-dial')
              await handleAgentDial(
                channelId,
                evt.args?.[1] ?? '',
                evt.args?.[2] ?? '',
                evt.channel?.name ?? '',
                log,
              );
            else if (role === 'outbound-leg') await handleOutboundLegAnswered(channelId, log);
            else if (role === 'threeway' || role === 'transfer')
              await handleJoinBridge(channelId, role, log);
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
