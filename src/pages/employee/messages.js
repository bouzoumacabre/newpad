import { renderEmployeeShell } from './shell.js';
import { renderMessagesScreen } from '../shared/messagesScreen.js';

export async function renderEmployeeMessages(app, profile, params = {}) {
  const { content } = await renderEmployeeShell(app, profile, 'messages');
  await renderMessagesScreen(content, profile, '/employee/messages', params.id);
}
