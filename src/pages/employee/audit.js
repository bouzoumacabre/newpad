import { renderEmployeeShell } from './shell.js';
import { renderAuditScreen } from '../shared/auditScreen.js';

export async function renderEmployeeAudit(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'audit');
  await renderAuditScreen(content, profile, { isAdmin: false });
}
