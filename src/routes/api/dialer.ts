import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

// Mock DB/State for fallback
const mockCallLogs = [
  {
    id: '1',
    phoneNumber: '+15550199',
    direction: 'outbound',
    duration: 124,
    status: 'completed',
    agentName: 'John Doe',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    notes: 'Interested in upgrading plan.',
  },
  {
    id: '2',
    phoneNumber: '+15550188',
    direction: 'inbound',
    duration: 45,
    status: 'missed',
    agentName: 'Sarah Smith',
    timestamp: new Date(Date.now() - 7200000).toISOString(),
    notes: 'Callback requested.',
  },
  {
    id: '3',
    phoneNumber: '+15550177',
    direction: 'outbound',
    duration: 320,
    status: 'completed',
    agentName: 'John Doe',
    timestamp: new Date(Date.now() - 10800000).toISOString(),
    notes: 'Follow up call scheduled for tomorrow.',
  },
];

const mockActiveCalls = [
  {
    id: 'a1',
    phoneNumber: '+15550100',
    direction: 'outbound',
    duration: 15,
    agentName: 'John Doe',
    status: 'in-progress',
  },
];

type SipSettings = {
  sip_domain: string;
  sip_port: number;
  username: string;
  nat_support: boolean;
};

export async function dialerRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Helper to get SIP configuration from Laravel backend
  async function getSipSettings(): Promise<SipSettings> {
    try {
      const res = await fetch('http://127.0.0.1:8000/api/sip');
      if (!res.ok) throw new Error('Laravel SIP config fetch failed');
      return (await res.json()) as SipSettings;
    } catch (err) {
      console.warn('Could not fetch SIP settings from Laravel backend, using fallback provider settings:', err);
      return {
        sip_domain: 'sip.provider.com',
        sip_port: 5060,
        username: 'trunk_main',
        nat_support: true,
      };
    }
  }

  // 1. Get all call logs
  app.get(
    '/logs',
    {
      schema: {
        description: 'Get list of past call logs',
        tags: ['dialer'],
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              phoneNumber: z.string(),
              direction: z.enum(['inbound', 'outbound']),
              duration: z.number(),
              status: z.enum(['completed', 'missed', 'failed', 'busy']),
              agentName: z.string(),
              timestamp: z.string(),
              notes: z.string().optional(),
            })
          ),
        },
      },
    },
    async () => {
      return mockCallLogs;
    }
  );

  // 2. Get currently active calls
  app.get(
    '/active',
    {
      schema: {
        description: 'Get list of active calls in progress',
        tags: ['dialer'],
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              phoneNumber: z.string(),
              direction: z.enum(['inbound', 'outbound']),
              duration: z.number(),
              agentName: z.string(),
              status: z.string(),
            })
          ),
        },
      },
    },
    async () => {
      return mockActiveCalls;
    }
  );

  // 3. Initiate a new call (connects to Asterisk via ARI REST interface)
  app.post(
    '/calls',
    {
      schema: {
        description: 'Initiate a new outbound call via Asterisk ARI',
        tags: ['dialer'],
        body: z.object({
          phoneNumber: z.string().min(5),
          agentName: z.string(),
          provider: z.enum(['twilio', 'telnyx', 'generic']).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            phoneNumber: z.string(),
            direction: z.string(),
            status: z.string(),
            message: z.string(),
            ariStatus: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { phoneNumber, agentName, provider } = request.body;
      const callId = Math.random().toString(36).substring(7);
      const selectedProvider = provider || 'twilio';

      const newCall = {
        id: callId,
        phoneNumber,
        direction: 'outbound' as const,
        duration: 0,
        agentName,
        status: 'initiating',
      };

      // Add to active calls list
      mockActiveCalls.push(newCall);

      // Log immediately
      mockCallLogs.unshift({
        id: newCall.id,
        phoneNumber: newCall.phoneNumber,
        direction: newCall.direction,
        duration: 0,
        status: 'completed',
        agentName: newCall.agentName,
        timestamp: new Date().toISOString(),
        notes: `Outbound call triggered via ${selectedProvider} provider.`,
      });

      // --- ARI Call Origination to Asterisk ---
      let ariStatus = 'Mock pipeline used (Asterisk connection skipped)';
      try {
        const auth = Buffer.from('mkb_user:mkb_pass').toString('base64');
        
        // Resolve provider specific domain/port
        let providerDomain = '';
        let providerPort = 5060;
        
        if (selectedProvider === 'telnyx') {
          providerDomain = process.env.TELNYX_SIP_DOMAIN || 'sip.telnyx.com';
          providerPort = parseInt(process.env.TELNYX_SIP_PORT || '5060', 10);
        } else if (selectedProvider === 'generic') {
          providerDomain = process.env.GENERIC_SIP_DOMAIN || 'sip.customprovider.com';
          providerPort = parseInt(process.env.GENERIC_SIP_PORT || '5060', 10);
        } else {
          providerDomain = process.env.TWILIO_SIP_DOMAIN || 'your-twilio-domain.pstn.twilio.com';
          providerPort = parseInt(process.env.TWILIO_SIP_PORT || '5060', 10);
        }

        // Build Endpoint Dial String matching Asterisk pjsip config (e.g. twilio-trunk)
        const dialEndpoint = `PJSIP/${selectedProvider}-trunk/sip:${phoneNumber}@${providerDomain}:${providerPort}`;
        
        const ariUrl = `http://localhost:8088/ari/channels?endpoint=${encodeURIComponent(dialEndpoint)}&extension=1000&context=from-internal&priority=1`;
        
        console.log(`[Asterisk ARI] Sending originate request to: ${ariUrl}`);
        
        const ariRes = await fetch(ariUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`
          }
        });

        if (ariRes.ok) {
          const ariData = await ariRes.json() as any;
          ariStatus = `Asterisk ARI Channel initiated via ${selectedProvider}. Channel ID: ${ariData.id}`;
          console.log(`[Asterisk ARI] Success: ${ariStatus}`);
        } else {
          const errText = await ariRes.text();
          ariStatus = `Asterisk ARI responded with error status: ${ariRes.status} (${errText})`;
          console.warn(`[Asterisk ARI] Warning: ${ariStatus}`);
        }
      } catch (err) {
        ariStatus = `Failed to connect to Asterisk ARI REST endpoint: ${(err as Error).message}`;
        console.error(`[Asterisk ARI] Error: ${ariStatus}`);
      }

      reply.code(201);
      return {
        id: newCall.id,
        phoneNumber: newCall.phoneNumber,
        direction: newCall.direction,
        status: newCall.status,
        message: 'Call initiated successfully.',
        ariStatus,
      };
    }
  );

  // 4. Get stats
  app.get(
    '/stats',
    {
      schema: {
        description: 'Get dialer statistics summary',
        tags: ['dialer'],
        response: {
          200: z.object({
            totalCalls: z.number(),
            completedCalls: z.number(),
            missedCalls: z.number(),
            averageDurationSeconds: z.number(),
          }),
        },
      },
    },
    async () => {
      const totalCalls = mockCallLogs.length;
      const completedCalls = mockCallLogs.filter(c => c.status === 'completed').length;
      const missedCalls = mockCallLogs.filter(c => c.status === 'missed').length;
      const totalDuration = mockCallLogs.reduce((acc, c) => acc + c.duration, 0);
      const averageDurationSeconds = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

      return {
        totalCalls,
        completedCalls,
        missedCalls,
        averageDurationSeconds,
      };
    }
  );
}
