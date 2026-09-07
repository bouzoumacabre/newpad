import { renderEmployeeShell } from './shell.js';
import { renderStaffDocumentsScreen } from '../shared/staffDocumentsScreen.js';

export async function renderEmployeeDocuments(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'documents');
  await renderStaffDocumentsScreen(content, profile, { canRevoke: false });
}
