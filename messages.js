import { renderAdminShell } from './shell.js';
import { renderMessagesScreen } from '../shared/messagesScreen.js';

export async function renderAdminMessages(app, profile, params = {}) {
  const { content } = await renderAdminShell(app, profile, 'messages');
  await renderMessagesScreen(content, profile, '/admin/messages', params.id);
}
