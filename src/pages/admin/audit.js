import { renderAdminShell } from './shell.js';
import { renderAuditScreen } from '../shared/auditScreen.js';

export async function renderAdminAudit(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'audit');
  await renderAuditScreen(content, profile, { isAdmin: true });
}
