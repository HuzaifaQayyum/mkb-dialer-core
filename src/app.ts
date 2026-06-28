import fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { dialerRoutes } from './routes/api/dialer.js';

export function buildApp() {
  const app = fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Set up Zod validation/serialization compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Sensible plugin for easy HTTP error handling
  app.register(sensible);

  // Register CORS
  app.register(cors, {
    origin: true, // Allow all origins for development, adjust for production
    credentials: true,
  });

  // Register Swagger and Swagger UI
  app.register(swagger, {
    openapi: {
      info: {
        title: 'MKB Dialer API',
        description: 'Backend API for the MKB Dialer Application',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:5000',
          description: 'Development Server',
        },
      ],
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  // Root endpoint
  app.get('/', async () => {
    return {
      name: 'MKB Dialer API',
      status: 'healthy',
      version: '1.0.0',
      docs: '/docs',
    };
  });

  // Register dialer routes
  app.register(dialerRoutes, { prefix: '/api/dialer' });

  return app;
}
