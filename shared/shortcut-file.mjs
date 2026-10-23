// Apple Shortcuts files for Siri capture and the share sheet. "Update my todos" asks one question
// and sends the whole sentence; "Send to Todos" takes what the share sheet hands it. All post to /kanban/capture with the user's token in a header and show the reply.
// The device's current time travels along so "tomorrow at 9" is the phone's tomorrow. iOS only
// installs signed files, so `shortcuts sign` (macOS) runs on the server.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OBJ = '￼'; // the placeholder a variable occupies inside Shortcuts text

export const SHORTCUTS = {
  // The name is the Siri phrase. A longer one is caught far better than a bare "todo", but it must
  // not read as a Reminders command: "update my todos" made Siri look for a Reminders list "todos".
  todo: { name: 'Update my board', say: 'Hey Siri, update my board', example: '“call the plumber tomorrow at 9”, “add a checklist groceries with milk and eggs”, “add some items to watch movie” (Siri asks which), “remind me about the dentist on Friday at 6”', asks: [['say', 'What would you like?']], glyph: 59511, color: 463140863 },
  send: { name: 'Send to Todos', say: 'Share sheet → Send to Todos', example: 'a video, an article, a link or some text becomes a card to follow up on', share: true, asks: [], glyph: 59511, color: 4282601983 },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(v, pad = '') {
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => plist(x, pad + '  ')).join('\n')}\n${pad}</array>`;
  return `${pad}<dict>\n${Object.entries(v).map(([k, x]) => `${pad}  <key>${esc(k)}</key>\n${plist(x, pad + '  ')}`).join('\n')}\n${pad}</dict>`;
}

const text = (s) => ({ WFSerializationType: 'WFTextTokenString', Value: { string: s } });
const ref = (uuid, name) => ({ WFSerializationType: 'WFTextTokenString', Value: { string: OBJ, attachmentsByRange: { '{0, 1}': { Type: 'ActionOutput', OutputUUID: uuid, OutputName: name } } } });
const attachment = (uuid, name) => ({ WFSerializationType: 'WFTextTokenAttachment', Value: { Type: 'ActionOutput', OutputUUID: uuid, OutputName: name } });
const shared = () => ({ WFSerializationType: 'WFTextTokenString', Value: { string: OBJ, attachmentsByRange: { '{0, 1}': { Type: 'ExtensionInput' } } } });
const sharedAttachment = () => ({ WFSerializationType: 'WFTextTokenAttachment', Value: { Type: 'ExtensionInput' } });
const dictionary = (entries) => ({ WFSerializationType: 'WFDictionaryFieldValue', Value: { WFDictionaryFieldValueItems: entries.map(([k, v]) => ({ WFItemType: 0, WFKey: text(k), WFValue: v })) } });
const action = (id, params) => ({ WFWorkflowActionIdentifier: id, WFWorkflowActionParameters: params });

/** The shortcut as plist XML. `base` is the app origin, `token` the user's capture token. */
export function shortcutXml(kind, { base, token }) {
  const def = SHORTCUTS[kind];
  if (!def) throw new Error('unknown shortcut');
  const actions = [];
  const body = [];
  for (const [field, prompt] of def.asks) {
    const uuid = crypto.randomUUID().toUpperCase();
    const name = 'Request';
    actions.push(action('is.workflow.actions.ask', { UUID: uuid, WFAskActionPrompt: prompt, WFInputType: 'Text', CustomOutputName: name }));
    body.push([field, ref(uuid, name)]);
  }
  if (def.share) {
    // What the share sheet handed over: its links, and the whole thing as text (a page's URL, a selection).
    const links = crypto.randomUUID().toUpperCase();
    actions.push(action('is.workflow.actions.detect.link', { UUID: links, WFInput: sharedAttachment(), CustomOutputName: 'Links' }));
    body.push(['url', ref(links, 'Links')]);
    body.push(['text', shared()]);
  }
  // The phone's clock with its zone, as ISO 8601, so a spoken "tomorrow at 9" is its tomorrow.
  const clock = crypto.randomUUID().toUpperCase();
  const iso = crypto.randomUUID().toUpperCase();
  actions.push(action('is.workflow.actions.date', { UUID: clock, WFDateActionMode: 'Current Date', CustomOutputName: 'Now' }));
  actions.push(action('is.workflow.actions.format.date', { UUID: iso, WFInput: attachment(clock, 'Now'), WFDateFormatStyle: 'ISO 8601', WFISO8601IncludeTime: true, CustomOutputName: 'Now ISO' }));
  body.push(['now', ref(iso, 'Now ISO')]);
  const send = (uuid, fields, name) => action('is.workflow.actions.downloadurl', {
    UUID: uuid,
    WFURL: `${base}/kanban/capture`,
    WFHTTPMethod: 'POST',
    ShowHeaders: true,
    WFHTTPHeaders: dictionary([['Authorization', text(`Bearer ${token}`)], ['Accept', text('text/plain')]]),
    WFHTTPBodyType: 'JSON',
    WFJSONValues: dictionary(fields),
    CustomOutputName: name,
  });
  const post = crypto.randomUUID().toUpperCase();
  actions.push(send(post, body, 'Reply'));
  if (def.share) actions.push(action('is.workflow.actions.notification', { WFNotificationActionBody: ref(post, 'Reply'), WFNotificationActionSound: false }));
  else if (def.asks.some(([field]) => field === 'say')) {
    // "add some items to groceries" comes back as a question; ask it, send the items with the same sentence.
    const group = crypto.randomUUID().toUpperCase();
    const asText = crypto.randomUUID().toUpperCase();
    const items = crypto.randomUUID().toUpperCase();
    const again = crypto.randomUUID().toUpperCase();
    // The reply is a file to Shortcuts; only text offers a "contains" condition.
    actions.push(action('is.workflow.actions.detect.text', { UUID: asText, WFInput: attachment(post, 'Reply'), CustomOutputName: 'Reply text' }));
    actions.push(action('is.workflow.actions.conditional', { GroupingIdentifier: group, WFControlFlowMode: 0, WFCondition: 99, WFInput: { Type: 'Variable', Variable: attachment(asText, 'Reply text') }, WFConditionalActionString: 'Which items' }));
    actions.push(action('is.workflow.actions.ask', { UUID: items, WFAskActionPrompt: ref(post, 'Reply'), WFInputType: 'Text', CustomOutputName: 'Items' }));
    actions.push(send(again, [...body, ['items', ref(items, 'Items')]], 'Reply 2'));
    actions.push(action('is.workflow.actions.showresult', { Text: ref(again, 'Reply 2') }));
    actions.push(action('is.workflow.actions.conditional', { GroupingIdentifier: group, WFControlFlowMode: 1 }));
    actions.push(action('is.workflow.actions.showresult', { Text: ref(post, 'Reply') }));
    actions.push(action('is.workflow.actions.conditional', { GroupingIdentifier: group, WFControlFlowMode: 2 }));
  } else actions.push(action('is.workflow.actions.showresult', { Text: ref(post, 'Reply') }));
  const doc = {
    WFWorkflowClientVersion: '2607.0.3',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowHasShortcutInputVariables: !!def.share,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowIcon: { WFWorkflowIconStartColor: def.color, WFWorkflowIconGlyphNumber: def.glyph },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: def.share ? ['WFURLContentItem', 'WFStringContentItem', 'WFSafariWebPageContentItem', 'WFArticleContentItem', 'WFRichTextContentItem'] : [],
    WFWorkflowTypes: def.share ? ['ActionExtension'] : ['WatchKit'], // the share sheet, or Siri on the watch too
    WFWorkflowActions: actions,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plist(doc)}\n</plist>\n`;
}

/** Sign with the system `shortcuts` tool (macOS). Resolves to the signed bytes, or null where there is no such tool. */
export async function signShortcut(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-shortcut-'));
  const input = path.join(dir, 'in.shortcut');
  const output = path.join(dir, 'out.shortcut');
  try {
    fs.writeFileSync(input, xml, { mode: 0o600 });
    await run('/usr/bin/shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', output], { timeout: 20000 });
    return fs.readFileSync(output);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const signingAvailable = () => process.platform === 'darwin' && fs.existsSync('/usr/bin/shortcuts');
