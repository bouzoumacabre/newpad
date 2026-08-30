import { renderEmployeeShell } from './shell.js';
import { renderConsultingQueue } from '../shared/consultingQueue.js';

export async function renderEmployeeConsulting(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'consulting');
  await renderConsultingQueue(content, profile);
}
