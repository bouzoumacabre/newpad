import { renderEmployeeShell } from './shell.js';
import { renderStaffSupportScreen } from '../shared/staffSupportScreen.js';

export async function renderEmployeeSupport(app, profile, params = {}) {
  const { content } = await renderEmployeeShell(app, profile, 'support');
  await renderStaffSupportScreen(content, profile, '/employee/support', params.id);
}
