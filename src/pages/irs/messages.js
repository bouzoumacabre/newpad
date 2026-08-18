import { renderIrsShell } from './shell.js';
import { renderMessagesScreen } from '../shared/messagesScreen.js';

export async function renderIrsMessages(app, profile, params = {}) {
  const { content } = await renderIrsShell(app, profile, 'messages');
  await renderMessagesScreen(content, profile, '/irs/messages', params.id);
}
