import { renderAdminShell } from './shell.js';
import { renderFraudScreen } from '../shared/fraudScreen.js';

export async function renderAdminFraud(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'fraud');
  await renderFraudScreen(content, profile, '/admin/fraud');
}
