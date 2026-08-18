import { renderClientShell } from './shell.js';
import { renderMessagesScreen } from '../shared/messagesScreen.js';

export async function renderClientMessages(app, profile, params = {}) {
  const { content } = await renderClientShell(app, profile, 'messages');
  await renderMessagesScreen(content, profile, '/client/messages', params.id);
}
