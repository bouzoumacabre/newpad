import { renderAdminShell } from './shell.js';
import { renderStaffSupportScreen } from '../shared/staffSupportScreen.js';

export async function renderAdminSupport(app, profile, params = {}) {
  const { content } = await renderAdminShell(app, profile, 'support');
  await renderStaffSupportScreen(content, profile, '/admin/support', params.id);
}
