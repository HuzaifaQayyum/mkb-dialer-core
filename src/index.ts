import dotenv from 'dotenv';
import { buildApp } from './app.js';
import { startAriListener } from './services/ari.js';

dotenv.config();

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;
const host = process.env.HOST || '0.0.0.0';

const app = buildApp();

const start = async () => {
  try {
    await app.listen({ port, host });
    console.log(`🚀 Server is listening at http://${host}:${port}`);
    console.log(`📄 API documentation available at http://${host}:${port}/docs`);

    // Hold the Stasis websocket so answered leads can be bridged to agents.
    startAriListener(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
