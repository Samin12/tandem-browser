import { loadConfig } from './config';
import { createGateway } from './server';
import { log } from './audit';
try {
  const config = await loadConfig();
  const gateway = createGateway(config);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (error) {
  log('gateway.startup_failed', { message: error instanceof Error && /^(TANDEM_[A-Z_]+:)/.test(error.message) ? error.message : 'Unable to initialize gateway; check data and public directories' });
  process.exit(1);
}
