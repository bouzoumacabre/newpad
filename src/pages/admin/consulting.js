import { renderAdminShell } from './shell.js';
import { renderConsultingQueue } from '../shared/consultingQueue.js';

export async function renderAdminConsulting(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'consulting');
  await renderConsultingQueue(content, profile);
}
