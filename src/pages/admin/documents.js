import { renderAdminShell } from './shell.js';
import { renderStaffDocumentsScreen } from '../shared/staffDocumentsScreen.js';

export async function renderAdminDocuments(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'documents');
  await renderStaffDocumentsScreen(content, profile, { canRevoke: true });
}
