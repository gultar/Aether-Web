const state = {
  models: [],
  conversations: [],
  presets: [],
  current: null,
  generating: false,
  runtimeModelPath: null,
  defaults: {},
  tools: [],
  skills: [],
  externalTools: { directory: "tools/external", template: "" },
  activeAssistant: null,
  autoScroll: true,
  toastTimer: null,
  selectingConversations: false,
  selectedConversationIds: new Set(),
  pendingAttachments: [],
  interruptPending: false,
  queuedInterrupt: null,
  activeSkill: null,
  lastSkillRouting: null,
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function bootstrap() {
  hideActivity();
  const data = await api('/api/bootstrap');
  state.models = data.models || [];
  state.conversations = data.conversations || [];
  state.presets = data.presets || [];
  state.runtimeModelPath = data.runtime?.model_path || null;
  state.defaults = data.defaults || {};
  state.tools = data.tools || [];
  state.skills = data.skills || [];
  state.externalTools = data.external_tools || state.externalTools;
  updateVramBadge(data.runtime || null);
  if ($('external-tools-dir')) $('external-tools-dir').textContent = state.externalTools.directory || 'tools/external';
  renderModelSelectors();
  renderSkillSelector();
  renderPresets();
  renderConversationList();
  const requestedConversationId = new URLSearchParams(window.location.search).get('conversation');
  await recoverActiveConversation(requestedConversationId || state.conversations[0]?.id || null);
  if (!state.current?.model_id) {
    openSettings();
    toast(state.models.length ? 'Select a GGUF model to begin.' : 'Choose a GGUF model to begin.');
  }
}

function ensureSkillCategoryStatus() {
  const select = $('skill-select');
  if (!select) return null;
  let pill = $('skill-category-status');
  if (pill) return pill;
  pill = document.createElement('span');
  pill.id = 'skill-category-status';
  pill.textContent = 'Category: Auto';
  pill.title = 'Step 1 of the two-stage router';
  Object.assign(pill.style, {
    display: 'inline-flex', alignItems: 'center', minHeight: '30px', maxWidth: '190px',
    padding: '0 9px', border: '1px solid rgba(255,255,255,.13)', borderRadius: '7px',
    background: 'rgba(255,255,255,.045)', color: 'var(--muted, #aab4c0)',
    fontSize: '10px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', flex: '0 1 auto'
  });
  select.insertAdjacentElement('beforebegin', pill);
  return pill;
}

function updateSkillCategoryStatus(category = null) {
  const pill = ensureSkillCategoryStatus();
  if (!pill) return;
  if (!category) {
    const mode = $('skill-select')?.value || state.current?.settings?.skill_mode || 'auto';
    if (mode !== 'auto') category = state.skills.find(s => s.name === mode)?.category || null;
  }
  pill.textContent = `Category: ${category || 'Auto'}`;
  pill.title = category
    ? `Step 1 category: ${category}. Step 2 selects a skill only inside this category.`
    : 'Step 1 will choose a category, then Step 2 will choose a skill inside it.';
}

function renderSkillSelector() {
  const select = $('skill-select');
  if (!select) return;
  const selected = select.value || state.current?.settings?.skill_mode || 'auto';
  select.innerHTML = '<option value="auto">Skill: Auto — Category → Skill</option>';

  const groups = new Map();
  for (const skill of state.skills) {
    const category = skill.category || 'General';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(skill);
  }
  for (const category of [...groups.keys()].sort((a,b)=>a.localeCompare(b))) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const skill of groups.get(category).sort((a,b)=>a.name.localeCompare(b.name))) {
      const option = document.createElement('option');
      option.value = skill.name;
      option.textContent = skill.name;
      option.title = `${category} · ${skill.description || skill.name}`;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  select.value = [...select.options].some(o => o.value === selected) ? selected : 'auto';
  updateSkillCategoryStatus(state.lastSkillRouting?.selected_category || null);
}

async function refreshSkillsFromServer() {
  try {
    const data = await api('/api/os/skills');
    state.skills = data.skills || [];
    renderSkillSelector();
  } catch (error) {
    console.warn('Could not refresh skills', error);
  }
}

function openBrowserOSSkillEditor() {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'browseros-open-skill-editor' }, '*');
    return;
  }
  toast('Open BrowserOS to use the Skills Editor.');
}


function updateSkillWhyButton() {
  const button = $('skill-why-btn');
  if (!button) return;
  const routing = state.lastSkillRouting;
  button.disabled = !routing;
  if (!routing) {
    button.title = 'Send a message to inspect the most recent skill-routing decision.';
    return;
  }
  const selected = routing.selected_skill || state.activeSkill || 'skill';
  const category = routing.selected_category ? `${routing.selected_category} → ` : '';
  const reason = String(routing.reason || '').trim();
  button.title = reason ? `${category}${selected}: ${reason}` : `Why ${category}${selected} was selected`;
}

function openSkillWhyModal() {
  const routing = state.lastSkillRouting;
  if (!routing) return toast('No skill-routing decision is available yet.');
  document.querySelector('.tiny-skill-why-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'tiny-skill-why-overlay';
  const modal = document.createElement('section');
  modal.className = 'tiny-skill-why-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'tiny-skill-why-head';
  const headText = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Why this skill?';
  const subtitle = document.createElement('small');
  subtitle.textContent = 'Compact routing diagnostics — not model chain-of-thought.';
  headText.append(title, subtitle);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-btn';
  closeButton.textContent = '✕';
  head.append(headText, closeButton);

  const summary = document.createElement('div');
  summary.className = 'tiny-skill-why-summary';
  const category = document.createElement('div');
  category.innerHTML = '<span>Selected category</span>';
  const categoryValue = document.createElement('strong');
  categoryValue.textContent = routing.selected_category || 'n/a';
  category.appendChild(categoryValue);
  const selected = document.createElement('div');
  selected.innerHTML = '<span>Selected skill</span>';
  const selectedValue = document.createElement('strong');
  selectedValue.textContent = routing.selected_skill || state.activeSkill || 'unknown';
  selected.appendChild(selectedValue);
  const mode = document.createElement('div');
  mode.innerHTML = '<span>Selection mode</span>';
  const modeValue = document.createElement('strong');
  modeValue.textContent = routing.selection_mode || 'auto';
  mode.appendChild(modeValue);
  summary.append(category, selected, mode);

  const reasonBlock = document.createElement('div');
  reasonBlock.className = 'tiny-skill-why-reason';
  const categoryReasonLabel = document.createElement('span');
  categoryReasonLabel.textContent = 'Category reason';
  const categoryReasonText = document.createElement('p');
  categoryReasonText.textContent = routing.category_reason || 'No category rationale was returned.';
  const reasonLabel = document.createElement('span');
  reasonLabel.textContent = 'Skill reason';
  const reasonText = document.createElement('p');
  reasonText.textContent = routing.reason || 'No short rationale was returned.';
  reasonBlock.append(categoryReasonLabel, categoryReasonText, reasonLabel, reasonText);

  const candidatesBlock = document.createElement('div');
  candidatesBlock.className = 'tiny-skill-why-candidates';
  const candidateTitle = document.createElement('div');
  candidateTitle.className = 'tiny-skill-why-section-title';
  candidateTitle.textContent = 'Candidates shown to Ministral';
  candidatesBlock.appendChild(candidateTitle);

  const candidates = Array.isArray(routing.candidates) ? routing.candidates : [];
  if (!candidates.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No candidate list was recorded.';
    candidatesBlock.appendChild(empty);
  } else {
    for (const candidate of candidates) {
      const row = document.createElement('div');
      row.className = 'tiny-skill-why-candidate';
      if (candidate?.name === routing.selected_skill) row.classList.add('selected');
      const main = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = candidate?.name || 'unknown';
      const desc = document.createElement('small');
      desc.textContent = candidate?.description || '';
      main.append(name, desc);
      const score = document.createElement('span');
      const value = candidate?.retrieval_score;
      score.className = 'tiny-skill-why-score';
      score.textContent = Number.isFinite(Number(value)) && value !== null
        ? `score ${Number(value).toFixed(4)}`
        : 'all skills';
      row.append(main, score);
      candidatesBlock.appendChild(row);
    }
  }

  const note = document.createElement('p');
  note.className = 'tiny-skill-why-note';
  note.textContent = routing.score_note || '';

  modal.append(head, summary, reasonBlock, candidatesBlock, note);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  closeButton.onclick = close;
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
}

window.addEventListener('message', event => {
  if (event?.data?.type === 'browseros-skills-changed') refreshSkillsFromServer();
});

function renderPresets() {
  const sidebar = $('preset-select');
  const manager = $('preset-manager-select');
  const sidebarSelected = sidebar?.value || '';
  const managerSelected = manager?.value || '';

  if (sidebar) {
    sidebar.innerHTML = '<option value="">Default</option>';
    for (const preset of state.presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      sidebar.appendChild(option);
    }
    if ([...sidebar.options].some(o => o.value === sidebarSelected)) sidebar.value = sidebarSelected;
  }

  if (manager) {
    manager.innerHTML = '<option value="">New preset…</option>';
    for (const preset of state.presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      manager.appendChild(option);
    }
    if ([...manager.options].some(o => o.value === managerSelected)) manager.value = managerSelected;
  }

  populatePresetManagerFields();
}

function selectedManagedPreset() {
  const id = $('preset-manager-select')?.value || '';
  return state.presets.find(preset => String(preset.id) === String(id)) || null;
}

function populatePresetManagerFields() {
  const preset = selectedManagedPreset();
  if ($('preset-name')) $('preset-name').value = preset?.name || '';
  if ($('preset-description')) $('preset-description').value = preset?.description || '';
  if ($('update-preset-btn')) $('update-preset-btn').disabled = !preset;
  if ($('delete-preset-btn')) $('delete-preset-btn').disabled = !preset;
  if ($('load-preset-btn')) $('load-preset-btn').disabled = !preset;
}

async function refreshPresets(selectedId = null) {
  state.presets = await api('/api/presets');
  renderPresets();
  if (selectedId && $('preset-manager-select')) {
    $('preset-manager-select').value = selectedId;
    populatePresetManagerFields();
  }
}

function updateConversationBatchControls() {
  const bar = $('conversation-batch-bar');
  const toggle = $('conversation-select-btn');
  const selectAll = $('conversation-select-all');
  const count = $('conversation-selection-count');
  const deleteButton = $('delete-selected-chats-btn');

  if (bar) bar.hidden = !state.selectingConversations;
  if (toggle) toggle.textContent = state.selectingConversations ? 'Done' : 'Select';

  const existingIds = new Set(state.conversations.map(item => String(item.id)));
  for (const id of [...state.selectedConversationIds]) {
    if (!existingIds.has(String(id))) state.selectedConversationIds.delete(id);
  }

  const selectedCount = state.selectedConversationIds.size;
  if (count) count.textContent = `${selectedCount} selected`;
  if (deleteButton) deleteButton.disabled = selectedCount === 0 || state.generating;

  if (selectAll) {
    const total = state.conversations.length;
    selectAll.checked = total > 0 && selectedCount === total;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
  }
}

function renderConversationList() {
  const list = $('conversation-list');
  list.innerHTML = '';
  for (const conversation of state.conversations) {
    const row = document.createElement('div');
    row.className = 'conversation-row';

    if (state.selectingConversations) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'conversation-row-select';
      checkbox.checked = state.selectedConversationIds.has(String(conversation.id));
      checkbox.title = `Select ${conversation.title || 'New chat'}`;
      checkbox.setAttribute('aria-label', checkbox.title);
      checkbox.onchange = () => {
        const id = String(conversation.id);
        if (checkbox.checked) state.selectedConversationIds.add(id);
        else state.selectedConversationIds.delete(id);
        updateConversationBatchControls();
      };
      row.appendChild(checkbox);
    }

    const button = document.createElement('button');
    button.className = 'conversation-item' + (state.current?.id === conversation.id ? ' active' : '');
    button.textContent = conversation.title || 'New chat';
    button.title = conversation.title || 'New chat';
    button.onclick = () => loadConversation(conversation.id);
    row.appendChild(button);
    list.appendChild(row);
  }
  updateConversationBatchControls();
}

function renderModelSelectors() {
  for (const select of [$('model-select'), $('settings-model-select')]) {
    const selected = select.value;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.models.length ? 'Select model…' : 'Add a GGUF model…';
    select.appendChild(placeholder);
    for (const model of state.models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name + (model.exists ? '' : ' (missing)');
      option.disabled = !model.exists;
      select.appendChild(option);
    }
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
  }
  renderSettingsModelList();
}

function renderSettingsModelList() {
  const host = $('model-list-settings');
  host.innerHTML = '';
  for (const model of state.models) {
    const row = document.createElement('div');
    row.className = 'model-setting-row';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = model.name;
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = model.path + (model.exists ? '' : ' · missing');
    info.append(name, path);
    const remove = document.createElement('button');
    remove.className = 'remove-model';
    remove.textContent = '✕';
    remove.title = 'Remove from model list';
    remove.onclick = async () => {
      try {
        await api(`/api/models/${model.id}`, { method: 'DELETE' });
        await refreshModels();
        toast('Model removed from list');
      } catch (error) { toast(error.message); }
    };
    row.append(info, remove);
    host.appendChild(row);
  }
}

async function refreshModels() {
  state.models = await api('/api/models');
  renderModelSelectors();
  if (state.current) {
    $('model-select').value = state.current.model_id ?? '';
    $('settings-model-select').value = state.current.model_id ?? '';
  }
  updateModelDot();
}

async function refreshConversations() {
  state.conversations = await api('/api/conversations');
  renderConversationList();
}

async function recoverActiveConversation(preferredId = null) {
  const tryIds = [];
  const addId = value => {
    const id = String(value || '').trim();
    if (id && !tryIds.includes(id)) tryIds.push(id);
  };
  addId(preferredId);
  for (const item of state.conversations) addId(item?.id);

  for (const id of tryIds) {
    try {
      await loadConversation(id);
      return state.current;
    } catch (error) {
      if (!String(error?.message || '').toLowerCase().includes('conversation not found')) throw error;
    }
  }

  // The conversation list can be stale when a previous localhost agent
  // process owned the port or a database was replaced between builds.
  state.conversations = await api('/api/conversations');
  renderConversationList();
  for (const item of state.conversations) {
    try {
      await loadConversation(item.id);
      return state.current;
    } catch (error) {
      if (!String(error?.message || '').toLowerCase().includes('conversation not found')) throw error;
    }
  }

  const modelId = state.models[0]?.id || null;
  const conversation = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ model_id: modelId }),
  });
  await refreshConversations();
  await loadConversation(conversation.id);
  return state.current;
}

async function setConversationModel(modelId, { refreshList = true } = {}) {
  if (!state.current) throw new Error('No active conversation.');
  const normalized = modelId == null || modelId === '' ? null : Number(modelId);
  if (normalized !== null && !Number.isFinite(normalized)) throw new Error('Invalid model selection.');

  const updated = await api(`/api/conversations/${state.current.id}/model`, {
    method: 'POST',
    body: JSON.stringify({ model_id: normalized }),
  });
  state.current = updated;
  $('model-select').value = updated.model_id ?? '';
  $('settings-model-select').value = updated.model_id ?? '';
  updateModelDot();
  if (refreshList) await refreshConversations();
  return updated;
}

async function loadConversation(id) {
  state.pendingAttachments = [];
  renderAttachments();
  if (state.generating) return toast('Stop the current generation before switching chats.');
  hideActivity();
  const conversation = await api(`/api/conversations/${id}`);
  state.current = conversation;
  $('chat-title').value = conversation.title;
  $('model-select').value = conversation.model_id ?? '';
  fillSettings(conversation);
  renderSkillSelector();
  renderMessages(conversation.messages || []);
  renderConversationList();
  updateModelDot();
  closeMobileSidebar();
}

function renderMessages(messages) {
  const host = $('messages');
  host.innerHTML = '';
  $('empty-state').style.display = messages.length ? 'none' : 'flex';
  let lastUserTask = '';
  for (const message of messages) {
    if (message.role === 'user') lastUserTask = message.content || '';
    const meta = { ...message, teach_task: message.role === 'assistant' ? lastUserTask : '' };
    appendMessage(
      message.role,
      message.content,
      false,
      message.html || null,
      message.tool_traces || [],
      meta,
    );
  }
  state.autoScroll = true;
  scrollToBottom(false, true);
}

function appendMessage(role, content = '', scroll = true, renderedHtml = null, toolTraces = [], messageMeta = null) {
  $('empty-state').style.display = 'none';
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const head = document.createElement('div');
  head.className = 'message-head';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'assistant' ? 'AI' : 'YOU';
  const label = document.createElement('span');
  label.textContent = role === 'assistant' ? 'Assistant' : 'You';
  head.append(avatar, label);

  let editButton = null;
  if (role === 'user') {
    editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'message-edit-btn';
    editButton.textContent = 'Edit';
    editButton.title = 'Edit this message and regenerate from here';
    editButton.disabled = messageMeta?.id == null;
    head.appendChild(editButton);
  }

  let copyButton = null;
  let teachButton = null;
  if (role === 'assistant') {
    copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'message-copy-btn';
    copyButton.textContent = 'Copy';
    copyButton.title = 'Copy response as Markdown';
    head.appendChild(copyButton);

    teachButton = document.createElement('button');
    teachButton.type = 'button';
    teachButton.className = 'message-copy-btn teach-agent-skill-btn';
    teachButton.textContent = 'Teach skill';
    teachButton.title = 'Distill this successful tool run into a reusable skill draft';
    head.appendChild(teachButton);
  }

  const toolEvents = document.createElement('div');
  toolEvents.className = 'tool-events';
  const body = document.createElement('div');
  body.className = 'message-body';
  if (role === 'assistant' && renderedHtml) body.innerHTML = renderedHtml;
  else body.textContent = content;

  wrapper.append(head, toolEvents, body);

  const message = {
    wrapper, body, toolEvents, rawMarkdown: content || '', copyButton, editButton, teachButton,
    meta: messageMeta, toolTraces: Array.isArray(toolTraces) ? [...toolTraces] : [],
    teachTask: messageMeta?.teach_task || '',
  };

  if (editButton) {
    editButton.addEventListener('click', () => beginEditMessage(message));
  }

  if (role === 'assistant' && Array.isArray(toolTraces)) {
    for (const trace of toolTraces) appendToolTrace(toolEvents, trace, false);
  }

  if (copyButton) {
    copyButton.addEventListener('click', async () => {
      const markdown = message.rawMarkdown || body.innerText || '';
      const ok = await copyText(markdown);
      if (!ok) return toast('Could not copy the response.');
      const oldLabel = copyButton.textContent;
      copyButton.textContent = 'Copied';
      copyButton.classList.add('copied');
      setTimeout(() => {
        copyButton.textContent = oldLabel;
        copyButton.classList.remove('copied');
      }, 1200);
    });
  }

  if (teachButton) {
    const refreshTeachButton = () => {
      teachButton.hidden = !hasSuccessfulTeachTrace(message.toolTraces);
      teachButton.disabled = !hasSuccessfulTeachTrace(message.toolTraces);
    };
    message.refreshTeachButton = refreshTeachButton;
    refreshTeachButton();
    teachButton.onclick = () => teachAgentSkill(message);
  }

  $('messages').appendChild(wrapper);
  if (scroll) {
    state.autoScroll = true;
    scrollToBottom(true, true);
  }
  return message;
}

function beginEditMessage(message) {
  if (state.generating) return toast('Stop generation before editing a message.');
  if (!state.current || message?.meta?.id == null) return;
  if (message.wrapper.classList.contains('editing')) return;

  const original = message.rawMarkdown || '';
  message.wrapper.classList.add('editing');
  message.editButton.disabled = true;
  message.body.innerHTML = '';

  const editor = document.createElement('textarea');
  editor.className = 'message-edit-textarea';
  editor.value = original;
  editor.rows = Math.min(12, Math.max(2, original.split('\n').length + 1));

  const note = document.createElement('div');
  note.className = 'message-edit-note';
  note.textContent = 'Saving replaces this message and removes all later messages from this conversation.';

  const actions = document.createElement('div');
  actions.className = 'message-edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save & regenerate';
  actions.append(cancel, save);
  message.body.append(editor, note, actions);

  const restore = () => {
    message.wrapper.classList.remove('editing');
    message.body.textContent = original;
    message.editButton.disabled = false;
  };
  cancel.onclick = restore;

  save.onclick = async () => {
    const edited = editor.value.trim();
    if (!edited) return toast('Message cannot be empty.');
    if (edited === original.trim()) return restore();
    save.disabled = true;
    cancel.disabled = true;

    // Keep this message bubble, remove the now-invalid visible future, and run
    // the edited text through the normal streaming chat path. The backend does
    // the same truncation transactionally in SQLite before inference starts.
    let sibling = message.wrapper.nextElementSibling;
    while (sibling) {
      const next = sibling.nextElementSibling;
      sibling.remove();
      sibling = next;
    }

    message.wrapper.classList.remove('editing');
    message.rawMarkdown = edited;
    message.body.textContent = edited;
    message.editButton.disabled = true;

    try {
      await sendMessage({
        editMessageId: message.meta.id,
        prompt: edited,
        userMessage: message,
      });
      toast('Message edited and regenerated');
    } catch (error) {
      // sendMessage normally handles its own request errors; this is a final
      // guard for failures before the streaming request is started.
      await loadConversation(state.current.id).catch(() => {});
      toast(`Could not edit message: ${error.message}`);
    }
  };

  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // Fall through to the textarea method.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function hasSuccessfulTeachTrace(traces) {
  if (!Array.isArray(traces) || !traces.length) return false;
  return traces.every(trace => {
    const result = String(trace?.result || '').trim().toLowerCase();
    return result && !result.startsWith('tool error:') && !result.startsWith('tool is disabled') && !result.startsWith('failed:');
  });
}

async function skillApi(url, body) {
  return api(url, { method: 'POST', body: JSON.stringify(body) });
}

function openSkillDraftModal() {
  document.querySelector('.tiny-skill-draft-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'tiny-skill-draft-overlay';
  overlay.innerHTML = `
    <section class="tiny-skill-draft-modal" role="dialog" aria-modal="true">
      <div class="tiny-skill-draft-head">
        <div><strong>Teach Agent a Skill</strong><small>Review the draft before saving. Existing skills cannot be overwritten.</small></div>
        <button type="button" class="icon-btn tiny-skill-close">✕</button>
      </div>
      <div class="tiny-skill-status">Preparing draft…</div>
      <textarea class="tiny-skill-text" spellcheck="false"></textarea>
      <div class="tiny-skill-actions">
        <button type="button" class="secondary tiny-skill-discard">Discard</button>
        <button type="button" class="primary tiny-skill-save">Save skill</button>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.tiny-skill-close').onclick = close;
  overlay.querySelector('.tiny-skill-discard').onclick = close;
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  return {
    close,
    status: overlay.querySelector('.tiny-skill-status'),
    text: overlay.querySelector('.tiny-skill-text'),
    save: overlay.querySelector('.tiny-skill-save'),
  };
}

async function teachAgentSkill(message) {
  if (!hasSuccessfulTeachTrace(message?.toolTraces)) return toast('This run has no fully successful tool trace to teach.');
  const task = String(message.teachTask || '').trim();
  if (!task) return toast('Could not identify the user task for this response.');
  const ui = openSkillDraftModal();
  ui.text.readOnly = true;
  ui.text.placeholder = 'Ministral is distilling the successful tool trace…';
  ui.save.disabled = true;
  try {
    let data = await skillApi('/api/os/skills/teach', {
      task,
      response: message.rawMarkdown || message.body.innerText || '',
      tool_traces: message.toolTraces,
      force_new: false,
    });
    if (data.status === 'covered') {
      const existing = data.covered_by || {};
      const createAnyway = window.confirm(`This task appears to be covered by “${existing.name || 'an existing skill'}”.\n\n${existing.description || ''}\n\nCreate a separate draft anyway?`);
      if (!createAnyway) return ui.close();
      data = await skillApi('/api/os/skills/teach', {
        task,
        response: message.rawMarkdown || message.body.innerText || '',
        tool_traces: message.toolTraces,
        force_new: true,
      });
    }
    if (data.status !== 'draft' || !data.draft) throw new Error('No valid skill draft was returned.');
    if (!String(data.draft).trimStart().startsWith('---')) throw new Error('BrowserOS returned an invalid skill draft.');
    ui.text.value = data.draft;
    ui.text.placeholder = '';
    ui.text.readOnly = false;
    ui.save.disabled = false;
    const repairNotes = Array.isArray(data.normalization?.notes) ? data.normalization.notes : [];
    ui.status.textContent = repairNotes.length
      ? `Draft: ${data.skill?.name || 'new skill'} — BrowserOS repaired: ${repairNotes.join('; ')}. Review before saving.`
      : `Draft: ${data.skill?.name || 'new skill'} — edit anything before saving.`;
    ui.save.onclick = async () => {
      ui.save.disabled = true;
      ui.text.readOnly = true;
      ui.status.textContent = 'Validating and saving…';
      try {
        const saved = await skillApi('/api/os/skills/save', { draft: ui.text.value });
        ui.status.textContent = `Saved ${saved.skill?.name || 'skill'}. It will appear in the selector immediately.`;
        const list = await api('/api/os/skills');
        state.skills = list.skills || state.skills;
        renderSkillSelector();
        setTimeout(ui.close, 900);
      } catch (error) {
        ui.status.textContent = error.message;
        ui.save.disabled = false;
        ui.text.readOnly = false;
      }
    };
  } catch (error) {
    // Never leave a blank modal trapping the Tiny Web Agent UI after a draft failure.
    ui.close();
    toast(`Could not draft skill: ${error.message}`);
  }
}

function truncateTraceSummary(text, max = 105) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function toolPrimaryInput(name, args = {}) {
  if (name === 'run_powershell_command' && typeof args.cmd === 'string') {
    return { label: 'Command', value: args.cmd };
  }
  if ((name === 'duckduckgo_search' || name === 'web_search') && typeof args.query === 'string') {
    return { label: 'Query', value: args.query };
  }
  if (name === 'visit_url') {
    const value = args.url ?? args.href;
    if (typeof value === 'string') return { label: 'URL', value };
  }

  const entries = Object.entries(args || {});
  if (entries.length === 1 && typeof entries[0][1] === 'string') {
    return { label: prettyToolName(entries[0][0]), value: entries[0][1] };
  }
  return null;
}

function formatToolDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '';
  if (value < 1) return `${Math.max(1, Math.round(value * 1000))} ms`;
  return `${value.toFixed(value < 10 ? 2 : 1)} s`;
}

function traceSection(label, value) {
  const section = document.createElement('div');
  section.className = 'tool-trace-section';
  const heading = document.createElement('div');
  heading.className = 'tool-trace-section-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.className = 'tool-trace-pre';
  pre.textContent = String(value ?? '');
  section.append(heading, pre);
  return section;
}

function appendToolTrace(container, trace = {}, pending = false) {
  const callId = String(trace.call_id || (trace.id != null ? `stored-${trace.id}` : `tool-${trace.sequence ?? container.children.length + 1}`));
  let details = [...container.children].find(el => el.dataset.callId === callId);

  if (!details) {
    details = document.createElement('details');
    details.className = 'tool-trace';
    details.dataset.callId = callId;

    const summary = document.createElement('summary');
    summary.className = 'tool-trace-summary';

    const status = document.createElement('span');
    status.className = 'tool-trace-status';
    const name = document.createElement('span');
    name.className = 'tool-trace-name';
    const hint = document.createElement('span');
    hint.className = 'tool-trace-hint';
    const duration = document.createElement('span');
    duration.className = 'tool-trace-duration';

    summary.append(status, name, hint, duration);
    const content = document.createElement('div');
    content.className = 'tool-trace-content';
    details.append(summary, content);
    container.appendChild(details);
  }

  const name = String(trace.name || 'tool');
  const args = trace.arguments && typeof trace.arguments === 'object' ? trace.arguments : {};
  const primary = toolPrimaryInput(name, args);
  const status = details.querySelector('.tool-trace-status');
  const nameEl = details.querySelector('.tool-trace-name');
  const hint = details.querySelector('.tool-trace-hint');
  const duration = details.querySelector('.tool-trace-duration');
  const content = details.querySelector('.tool-trace-content');

  status.textContent = pending ? '●' : '✓';
  details.classList.toggle('pending', pending);
  details.classList.toggle('done', !pending);
  nameEl.textContent = prettyToolName(name);
  hint.textContent = primary?.value ? `— ${truncateTraceSummary(primary.value)}` : '';
  duration.textContent = pending ? 'Running…' : formatToolDuration(trace.duration_seconds);

  content.innerHTML = '';
  if (primary) {
    content.appendChild(traceSection(primary.label, primary.value));
    const remaining = Object.fromEntries(Object.entries(args).filter(([key]) => {
      if (name === 'run_powershell_command') return key !== 'cmd';
      if (name === 'duckduckgo_search' || name === 'web_search') return key !== 'query';
      if (name === 'visit_url') return key !== 'url' && key !== 'href';
      return !(Object.keys(args).length === 1);
    }));
    if (Object.keys(remaining).length) {
      content.appendChild(traceSection('Other arguments', JSON.stringify(remaining, null, 2)));
    }
  } else {
    content.appendChild(traceSection('Arguments', JSON.stringify(args, null, 2)));
  }

  if (pending) {
    const running = document.createElement('div');
    running.className = 'tool-trace-running';
    running.textContent = 'Waiting for tool result…';
    content.appendChild(running);
  } else {
    content.appendChild(traceSection('Result', trace.result || '(no output)'));
  }
  return details;
}

function prettyToolName(name) {
  return name.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isNearBottom() {
  const el = $('chat-scroll');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
}

function scrollToBottom(smooth = true, force = false) {
  const el = $('chat-scroll');
  if (!force && !state.autoScroll) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function hideActivity() {
  const activity = $('activity');
  activity.classList.remove('active');
  activity.setAttribute('aria-hidden', 'true');
}

function setGenerating(value) {
  state.generating = value;

  const waitingForInterrupt = value && state.interruptPending;
  const send = $('send-btn');
  const input = $('message-input');

  // Keep the composer usable while the model is generating. Sending another
  // prompt becomes an interrupt request: the current assistant turn is stopped
  // first, then the new user turn is submitted after the partial assistant
  // message has been committed.
  send.disabled = waitingForInterrupt;
  input.disabled = waitingForInterrupt;
  send.title = value
    ? (waitingForInterrupt ? 'Interrupting current response…' : 'Interrupt current response and send')
    : 'Send';

  if ($('attach-btn')) $('attach-btn').disabled = value;
  $('stop-btn').hidden = !value;

  if (!value) {
    hideActivity();
    input.disabled = false;
    send.disabled = false;
    send.title = 'Send';
    input.focus();
  }
}

function setActivity(text) {
  // Activity is driven by actual backend work, not by page/model state.
  if (!state.generating) {
    hideActivity();
    return;
  }
  $('activity-text').textContent = text;
  const activity = $('activity');
  activity.classList.add('active');
  activity.setAttribute('aria-hidden', 'false');
}

function updateModelDot(runtime = null) {
  const dot = $('model-dot');
  const selected = state.models.find(m => String(m.id) === String(state.current?.model_id));
  const loaded = !!selected && selected.path === state.runtimeModelPath;
  const governor = runtime?.vram_governor;
  dot.classList.toggle('loaded', loaded);
  if (!loaded && governor?.reserved) {
    dot.title = 'VRAM governor is reserving the GPU; model loading is temporarily blocked';
  } else {
    dot.title = loaded ? 'This model is loaded' : 'Model will load on the next message';
  }
}

function updateVramBadge(runtime = null) {
  const badge = $('vram-governor-badge');
  if (!badge) return;

  const governor = runtime?.vram_governor || {};
  const sample = governor?.sample || {};
  const loaded = !!runtime?.model_path;
  const stateName = String(governor?.state || 'unknown');
  const free = Number(sample?.free_mb);
  const used = Number(sample?.used_mb);
  const total = Number(sample?.total_mb);
  const footprint = Number(governor?.model_footprint_mb);
  const reserve = Number(governor?.reserve_mb);
  const external = Array.isArray(governor?.external_gpu_processes) ? governor.external_gpu_processes : [];
  const externalNames = external.slice(0, 3).map(item => String(item?.name || `PID ${item?.pid || '?'}`));

  badge.className = 'vram-badge';
  if (!governor?.enabled) {
    badge.textContent = 'VRAM: governor off';
  } else if (governor?.available === false) {
    badge.textContent = 'VRAM: unavailable';
    badge.classList.add('unavailable');
  } else if (stateName === 'waiting_for_turn') {
    badge.textContent = 'VRAM: unload pending';
    badge.classList.add('pending');
  } else if (stateName === 'process_detected') {
    badge.textContent = 'VRAM: GPU app detected';
    badge.classList.add('detected');
  } else if (stateName === 'pressure') {
    badge.textContent = 'VRAM: pressure';
    badge.classList.add('pressure');
  } else if (governor?.reserved && !loaded) {
    badge.textContent = 'VRAM: model offloaded';
    badge.classList.add('offloaded');
  } else if (stateName === 'recovering') {
    badge.textContent = 'VRAM: recovering';
    badge.classList.add('offloaded');
  } else if (loaded) {
    badge.textContent = 'VRAM: model loaded';
    badge.classList.add('loaded');
  } else {
    badge.textContent = 'VRAM: model unloaded';
  }

  const details = [];
  if (Number.isFinite(used) && Number.isFinite(total) && Number.isFinite(free)) {
    details.push(`GPU ${used}/${total} MiB used · ${free} MiB free`);
  }
  if (Number.isFinite(footprint) && footprint > 0) details.push(`learned model footprint ~${footprint} MiB`);
  if (Number.isFinite(reserve) && reserve > 0) details.push(`safety reserve ${reserve} MiB`);
  if (externalNames.length) details.push(`new GPU process: ${externalNames.join(', ')}`);
  if (governor?.reason) details.push(String(governor.reason));
  if (governor?.unavailable_reason) details.push(String(governor.unavailable_reason));
  badge.title = details.join('\n') || 'VRAM governor status';
  badge.dataset.details = details.join(' · ');
}

async function refreshRuntimeStatus() {
  try {
    const runtime = await api('/api/runtime');
    const wasLoaded = !!state.runtimeModelPath;
    state.runtimeModelPath = runtime?.model_path || null;
    updateModelDot(runtime);
    updateVramBadge(runtime);
    const governor = runtime?.vram_governor;
    const sample = governor?.sample;
    const free = Number(sample?.free_mb);
    const freeText = Number.isFinite(free) ? ` · ${free} MiB free` : '';

    if (state.generating) return;
    if (governor?.state === 'waiting_for_turn' && $('runtime-stats')) {
      $('runtime-stats').textContent = `VRAM pressure · unload pending after current task${freeText}`;
    } else if (governor?.state === 'process_detected' && $('runtime-stats')) {
      $('runtime-stats').textContent = `VRAM governor · new GPU app detected${freeText}`;
    } else if (governor?.state === 'pressure' && $('runtime-stats')) {
      $('runtime-stats').textContent = `VRAM pressure detected${freeText}`;
    } else if (governor?.state === 'reserved' && $('runtime-stats')) {
      $('runtime-stats').textContent = `VRAM governor · GPU reserved${freeText}`;
    } else if (governor?.state === 'recovering' && $('runtime-stats')) {
      $('runtime-stats').textContent = `VRAM governor · waiting for stable recovery${freeText}`;
    } else if (wasLoaded && !state.runtimeModelPath && $('runtime-stats')) {
      const seconds = Number(runtime?.idle_timeout_seconds || 300);
      const minutes = Math.max(1, Math.round(seconds / 60));
      $('runtime-stats').textContent = `Model offloaded after ${minutes} min idle`;
    }
  } catch (_) {
    // Runtime polling is informational only; never disturb an active chat.
  }
}


function renderAttachments() {
  const strip = $('attachment-strip');
  if (!strip) return;
  strip.innerHTML = '';
  strip.hidden = state.pendingAttachments.length === 0;

  for (const attachment of state.pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = `attachment-chip${attachment.uploading ? ' uploading' : ''}`;

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.filename || attachment.file?.name || 'Attachment';
    chip.appendChild(name);

    const kind = document.createElement('span');
    kind.className = 'attachment-kind';
    kind.textContent = attachment.uploading
      ? 'Indexing…'
      : `${attachment.chunks ?? 0} chunks`;
    chip.appendChild(kind);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove from this message';
    remove.textContent = '×';
    remove.disabled = !!attachment.uploading || state.generating;
    remove.onclick = () => {
      state.pendingAttachments = state.pendingAttachments.filter(item => item !== attachment);
      renderAttachments();
    };
    chip.appendChild(remove);
    strip.appendChild(chip);
  }
}

async function uploadAttachment(file) {
  if (!state.current) throw new Error('Open a conversation first.');
  const pending = { file, filename: file.name, uploading: true };
  state.pendingAttachments.push(pending);
  renderAttachments();

  const form = new FormData();
  form.append('file', file);
  try {
    const response = await fetch(`/api/conversations/${state.current.id}/attachments`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    Object.assign(pending, data.attachment || {}, { uploading: false, file: null });
    renderAttachments();
  } catch (error) {
    state.pendingAttachments = state.pendingAttachments.filter(item => item !== pending);
    renderAttachments();
    throw error;
  }
}

async function handleAttachmentFiles(files) {
  for (const file of Array.from(files || [])) {
    try {
      toast(`Preparing ${file.name}…`);
      await uploadAttachment(file);
    } catch (error) {
      console.error('Attachment upload failed:', error);
      toast(error.message);
    }
  }
  const input = $('attachment-input');
  if (input) input.value = '';
}

async function queueInterruptMessage() {
  if (!state.current || !state.generating || state.interruptPending) return;

  const input = $('message-input');
  const prompt = input.value.trim();
  if (!prompt) return;

  if (state.pendingAttachments.some(item => item.uploading)) {
    return toast('Wait for attachments to finish indexing.');
  }

  // Do not insert this user bubble yet. The active assistant turn must be
  // finalized in SQLite first so conversation roles always remain:
  // user -> assistant (possibly partial) -> user -> assistant.
  state.queuedInterrupt = { prompt };
  state.interruptPending = true;
  input.value = '';
  autosizeInput();
  setGenerating(true);
  setActivity('Interrupting…');

  try {
    await api('/api/cancel', { method: 'POST', body: '{}' });
  } catch (error) {
    state.queuedInterrupt = null;
    state.interruptPending = false;
    input.value = prompt;
    autosizeInput();
    setGenerating(true);
    toast(`Could not interrupt generation: ${error.message}`);
  }
}

async function sendMessage(options = null) {
  if (!state.current) {
    try {
      await recoverActiveConversation();
    } catch (error) {
      return toast(`Could not open a conversation: ${error.message}`);
    }
    if (!state.current) return toast('No active conversation.');
  }
  if (state.generating) {
    await queueInterruptMessage();
    return;
  }
  const editOptions = (options && typeof options === 'object') ? options : {};
  const editMessageId = editOptions.editMessageId ?? null;
  const input = $('message-input');
  let prompt = editOptions.prompt != null
    ? String(editOptions.prompt).trim()
    : input.value.trim();
  const readyAttachments = state.pendingAttachments.filter(item => item.id && !item.uploading);
  if (!prompt && !readyAttachments.length) return;
  if (state.pendingAttachments.some(item => item.uploading)) return toast('Wait for attachments to finish indexing.');
  if (!prompt) prompt = 'Please analyze the attached file or files.';

  // Treat the toolbar as the user's source of truth. Persist it before sending
  // so a programmatically selected model can never be UI-only.
  const toolbarModel = $('model-select').value;
  if (toolbarModel && String(state.current.model_id ?? '') !== toolbarModel) {
    try {
      await setConversationModel(toolbarModel, { refreshList: false });
    } catch (error) {
      return toast(error.message);
    }
  }
  if (!state.current.model_id) return toast('Select a GGUF model first.');

  let userMessage = editOptions.userMessage || null;
  if (editMessageId == null) {
    input.value = '';
    autosizeInput();
    userMessage = appendMessage('user', prompt);
  }
  const assistant = appendMessage('assistant', '');
  assistant.teachTask = prompt;
  assistant.body.classList.add('streaming');
  state.activeAssistant = assistant;
  setGenerating(true);
  hideActivity();
  $('runtime-stats').textContent = 'Starting…';

  try {
    const response = await fetch(`/api/chat/${state.current.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: prompt,
        model_id: state.current.model_id,
        skill: $('skill-select')?.value || state.current?.settings?.skill_mode || 'auto',
        attachment_ids: editMessageId == null ? readyAttachments.map(item => item.id) : [],
        ...(editMessageId != null ? { edit_message_id: editMessageId } : {}),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `${response.status} ${response.statusText}`);
    }

    if (editMessageId == null && readyAttachments.length) {
      const sentIds = new Set(readyAttachments.map(item => item.id));
      state.pendingAttachments = state.pendingAttachments.filter(item => !sentIds.has(item.id));
      renderAttachments();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        handleStreamEvent(event, assistant, userMessage);
      }
    }
    if (buffer.trim()) handleStreamEvent(JSON.parse(buffer), assistant, userMessage);
  } catch (error) {
    assistant.rawMarkdown += `\n\n[Error: ${error.message}]`;
    assistant.body.classList.add('streaming');
    assistant.body.textContent = assistant.rawMarkdown;
    toast(error.message);
    if (editMessageId != null && state.current) {
      await loadConversation(state.current.id).catch(() => {});
    }
  } finally {
    setGenerating(false);
    state.activeAssistant = null;
    await refreshConversations();
    if (state.current) {
      const refreshed = await api(`/api/conversations/${state.current.id}`).catch(() => null);
      if (refreshed) {
        state.current = refreshed;
        $('chat-title').value = refreshed.title;
        fillSettings(refreshed);
      }
    }
    renderConversationList();
    updateModelDot();

    // If the user submitted a prompt during inference, cancellation has now
    // fully completed and the partial assistant turn has been persisted. Start
    // the queued prompt as a normal new user turn only at this point.
    const queued = state.queuedInterrupt;
    if (queued) {
      state.queuedInterrupt = null;
      state.interruptPending = false;
      setGenerating(false);
      queueMicrotask(() => sendMessage({ prompt: queued.prompt, interruptedFollowup: true }));
    } else {
      state.interruptPending = false;
    }
  }
}

function handleStreamEvent(event, assistant, userMessage = null) {
  switch (event.event) {
    case 'user_saved':
      if (userMessage && event.message) {
        userMessage.meta = event.message;
        if (userMessage.editButton) userMessage.editButton.disabled = false;
      }
      break;
    case 'model_loading':
      setActivity(`Loading ${event.name}…`);
      $('runtime-stats').textContent = 'Loading model…';
      break;
    case 'model_loaded':
      state.runtimeModelPath = event.path;
      updateModelDot();
      hideActivity();
      $('runtime-stats').textContent = `Model loaded in ${event.seconds}s`;
      break;
    case 'skill_selection_start':
      state.activeSkill = null;
      state.lastSkillRouting = null;
      updateSkillWhyButton();
      updateSkillCategoryStatus(null);
      setActivity(event.mode === 'manual' ? 'Loading selected skill…' : 'Routing category…');
      $('runtime-stats').textContent = event.mode === 'manual' ? 'Skill: manual selection' : 'Skill: selecting…';
      break;
    case 'skill_category_selection_start':
      setActivity('Routing category…');
      $('runtime-stats').textContent = 'Skill router: selecting category…';
      break;
    case 'skill_category_selected':
      updateSkillCategoryStatus(event.category || null);
      setActivity(`Category · ${event.category}`);
      $('runtime-stats').textContent = `Category: ${event.category} · selecting skill…`;
      break;
    case 'skill_selected':
      state.activeSkill = event.skill || null;
      state.lastSkillRouting = event.routing || {
        selected_skill: event.skill || null,
        selection_mode: event.selection_mode || 'auto',
        reason: event.reason || '',
        candidates: event.candidates || [],
      };
      updateSkillWhyButton();
      const routedCategory = state.lastSkillRouting?.selected_category;
      updateSkillCategoryStatus(routedCategory || null);
      setActivity(`Skill · ${event.skill}`);
      $('runtime-stats').textContent = `${routedCategory ? `Category: ${routedCategory} · ` : ''}Skill: ${event.skill} · ${event.selection_mode || 'auto'}`;
      break;
    case 'inference_start':
      setActivity(event.tools ? `Thinking · ${event.tools} tools available` : 'Thinking…');
      $('runtime-stats').textContent = `${state.activeSkill ? `Skill: ${state.activeSkill} · ` : ''}~${event.estimated_context_tokens?.toLocaleString?.() ?? event.estimated_context_tokens} context tokens · ${event.tools ?? 0} tools`;
      if ($('active-tools-summary')) $('active-tools-summary').textContent = `Tools: ${event.tools ?? 0}`;
      break;
    case 'token':
      assistant.rawMarkdown += event.text || '';
      if (event.html) {
        assistant.body.classList.remove('streaming');
        assistant.body.innerHTML = event.html;
      } else {
        // Fallback for an older backend: preserve line breaks in raw streaming text.
        assistant.body.classList.add('streaming');
        assistant.body.textContent = assistant.rawMarkdown;
      }
      hideActivity();
      scrollToBottom(false);
      break;
    case 'file_overwrite_confirmation': {
      const approved = window.confirm(
        `This file already exists:

${event.path}

Overwrite it?`
      );
      fetch(`/api/file-overwrite-confirm/${event.confirmation_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      }).catch((error) => {
        console.error('Overwrite confirmation failed:', error);
        toast(`Overwrite confirmation failed: ${error.message}`);
      });
      setActivity(approved ? 'Overwrite approved…' : 'Overwrite cancelled…');
      break;
    }
    case 'tool_start':
      appendToolTrace(assistant.toolEvents, event, true);
      setActivity(`Using ${prettyToolName(event.name)}…`);
      scrollToBottom();
      break;
    case 'tool_end':
      appendToolTrace(assistant.toolEvents, event, false);
      assistant.toolTraces = Array.isArray(assistant.toolTraces) ? assistant.toolTraces : [];
      assistant.toolTraces.push({
        name: event.name,
        arguments: event.arguments || {},
        result: event.result || '',
        duration_seconds: event.duration_seconds,
      });
      assistant.refreshTeachButton?.();
      hideActivity();
      scrollToBottom(false);
      break;
    case 'timing': {
      const prompt = event.prompt_tps ? `${event.prompt_tps} tok/s prompt` : '';
      const generation = event.generation_tps ? `${event.generation_tps} tok/s gen` : '';
      const ttft = event.ttft_seconds != null ? `${event.ttft_seconds}s TTFT` : '';
      $('runtime-stats').textContent = [ttft, prompt, generation].filter(Boolean).join(' · ') || `${event.wall_seconds}s`;
      break;
    }
    case 'compaction':
      if (event.compacted) setActivity(`Compacted history to ~${event.estimated_tokens_after} tokens`);
      break;
    case 'done':
      hideActivity();
      assistant.body.classList.remove('streaming');
      if (event.response_html) assistant.body.innerHTML = event.response_html;
      if (event.conversation) {
        state.current.title = event.conversation.title;
        state.current.updated_at = event.conversation.updated_at;
      }
      break;
    case 'error':
      hideActivity();
      assistant.body.classList.add('streaming');
      assistant.rawMarkdown += `\n\n[Error: ${event.message}]`;
      assistant.body.textContent = assistant.rawMarkdown;
      toast(event.message);
      break;
  }
}

function toolEnabledForSettings(tool, settings) {
  const overrides = settings?.tool_overrides || {};
  if (Object.prototype.hasOwnProperty.call(overrides, tool.name)) {
    return !!overrides[tool.name];
  }
  return !!tool.enabled_by_default;
}

function renderToolToggles(settings = {}) {
  const host = $('tool-toggle-list');
  if (!host) return;
  host.innerHTML = '';

  const enabledTools = state.tools.filter(tool => toolEnabledForSettings(tool, settings));
  const summary = document.createElement('div');
  summary.className = 'tool-toggle-summary';
  summary.textContent = `Enabled for this conversation (${enabledTools.length}): ${enabledTools.length ? enabledTools.map(tool => tool.label || prettyToolName(tool.name)).join(', ') : 'none'}. Unchecked tools are registered but are not exposed to the model.`;
  host.appendChild(summary);

  if (!state.tools.length) {
    const empty = document.createElement('div');
    empty.className = 'tool-toggle-empty';
    empty.textContent = 'No tools registered.';
    host.appendChild(empty);
    return;
  }

  for (const tool of state.tools) {
    const row = document.createElement('label');
    row.className = 'tool-toggle-card';
    row.dataset.toolName = tool.name;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tool-toggle-checkbox';
    checkbox.dataset.toolName = tool.name;
    checkbox.checked = toolEnabledForSettings(tool, settings);

    const text = document.createElement('span');
    text.className = 'tool-toggle-text';
    const title = document.createElement('span');
    title.className = 'tool-toggle-title';
    title.textContent = tool.label || prettyToolName(tool.name);
    const description = document.createElement('span');
    description.className = 'tool-toggle-description';
    description.textContent = tool.description || tool.name;
    text.append(title, description);

    if (tool.source === 'external') {
      const source = document.createElement('span');
      source.className = 'tool-toggle-source';
      source.textContent = `External · ${tool.file || 'Python tool'}`;
      text.appendChild(source);
      if (tool.runtime_available === false) {
        const warning = document.createElement('span');
        warning.className = 'tool-toggle-warning';
        warning.textContent = 'Python runtime not found — this tool cannot execute yet.';
        text.appendChild(warning);
      }
    }

    row.append(checkbox, text);
    host.appendChild(row);
  }

  updateToolToggleAvailability();
}

function updateVisibleToolsSummary(settings = state.current?.settings || {}) {
  const el = $('active-tools-summary');
  if (!el) return;
  const mode = $('skill-select')?.value || settings.skill_mode || 'auto';
  if (mode === 'auto') {
    el.textContent = 'Tools: by skill';
    return;
  }
  if (mode !== 'general') {
    const skill = state.skills.find(item => item.name === mode);
    el.textContent = `Tools: ${skill?.tools?.length ?? 0} · ${mode}`;
    return;
  }
  const enabled = state.tools.filter(tool => toolEnabledForSettings(tool, settings));
  el.textContent = `Tools: ${enabled.length} · general`;
}

function updateToolToggleAvailability() {
  const master = $('tools_enabled');
  const disabled = master ? !master.checked : false;
  document.querySelectorAll('#tool-toggle-list .tool-toggle-checkbox').forEach(input => {
    input.disabled = disabled;
    input.closest('.tool-toggle-card')?.classList.toggle('disabled', disabled);
  });
}

function collectToolOverrides() {
  const overrides = {};
  document.querySelectorAll('#tool-toggle-list .tool-toggle-checkbox').forEach(input => {
    overrides[input.dataset.toolName] = input.checked;
  });
  return overrides;
}

function fillSettings(conversation) {
  const s = conversation.settings || {};
  $('settings-model-select').value = conversation.model_id ?? '';
  if ($('skill-select')) $('skill-select').value = s.skill_mode || 'auto';
  const fields = ['temperature','max_tokens','top_p','top_k','repeat_penalty','context_length','gpu_layers','n_batch','n_ubatch','threads','kv_cache','max_tool_calls','compaction_threshold','compaction_target','keep_recent_turns','summary_max_tokens','system_prompt'];
  for (const key of fields) if ($(key)) $(key).value = s[key] ?? '';
  for (const key of ['flash_attention','tools_enabled','compaction_enabled']) $(key).checked = !!s[key];
  $('offload_kqv').value = s.offload_kqv == null ? 'auto' : (s.offload_kqv ? 'on' : 'off');
  renderToolToggles(s);
  updateVisibleToolsSummary(s);
}

function requiredNumber(id) {
  const raw = $(id).value.trim();
  if (raw === '') throw new Error(`${id.replaceAll('_', ' ')} cannot be empty.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${id.replaceAll('_', ' ')} must be a number.`);
  return value;
}

function nullableNumber(id) {
  const raw = $(id).value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${id.replaceAll('_', ' ')} must be a number or Auto.`);
  return value;
}

function collectSettings() {
  const requiredNumberFields = ['temperature','max_tokens','context_length','gpu_layers','threads','max_tool_calls','compaction_threshold','compaction_target','keep_recent_turns','summary_max_tokens'];
  const optionalNumberFields = ['top_p','top_k','repeat_penalty','n_batch','n_ubatch'];
  const settings = { tool_policy_version: 2 };
  for (const key of requiredNumberFields) settings[key] = requiredNumber(key);
  for (const key of optionalNumberFields) settings[key] = nullableNumber(key);
  settings.kv_cache = $('kv_cache').value;
  settings.system_prompt = $('system_prompt').value;
  settings.skill_mode = $('skill-select')?.value || 'auto';
  for (const key of ['flash_attention','tools_enabled','compaction_enabled']) settings[key] = $(key).checked;
  settings.tool_overrides = collectToolOverrides();
  settings.offload_kqv = $('offload_kqv').value === 'auto' ? null : $('offload_kqv').value === 'on';
  return settings;
}

async function changeSkillMode() {
  if (!state.current || state.generating) return;
  const value = $('skill-select')?.value || 'auto';
  try {
    const updated = await api(`/api/conversations/${state.current.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ settings: { skill_mode: value } }),
    });
    state.current = updated;
    renderSkillSelector();
    updateSkillCategoryStatus(value === 'auto' ? null : (state.skills.find(s => s.name === value)?.category || null));
    updateVisibleToolsSummary(updated.settings || {});
    toast(value === 'auto' ? 'Skill selection set to Auto' : `Skill locked to ${value}`);
  } catch (error) {
    toast(`Could not change skill: ${error.message}`);
  }
}


function chooseExternalToolFile() {
  const input = $('external-tool-file-input');
  if (!input) return;
  input.value = '';
  input.click();
}

async function importExternalToolFile(file) {
  if (!file) return;
  const status = $('external-tool-file-status');
  if (!file.name.toLowerCase().endsWith('.py')) {
    toast('Choose a Python .py file');
    return;
  }
  if (status) status.textContent = `Importing ${file.name}…`;
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await fetch('/api/tools/external/import', { method: 'POST', body: form });
    const text = await response.text();
    let result = {};
    try { result = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok) throw new Error(result.error || text || `HTTP ${response.status}`);
    if (status) status.textContent = `Imported ${result.filename} → ${result.path}`;
    const editor = $('external-tool-definition');
    if (editor && state.externalTools?.template) {
      try {
        const template = JSON.parse(state.externalTools.template);
        template.file = result.filename;
        if (template.name === 'my_tool') {
          const stem = result.filename.replace(/\.py$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
          template.name = stem; template.function = stem; template.label = stem.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
        editor.value = JSON.stringify(template, null, 2);
      } catch (_) {}
    }
    toast(`Imported ${result.filename}`);
  } catch (error) {
    console.error('External Python import failed:', error);
    if (status) status.textContent = `Import failed: ${error.message}`;
    toast(error.message || 'External Python import failed');
  }
}

function loadExternalToolTemplate() {
  const editor = $('external-tool-definition');
  if (!editor) return;
  editor.value = state.externalTools?.template || `{
  "name": "my_tool",
  "file": "my_tool.py",
  "function": "my_tool",
  "label": "My Tool",
  "description": "Describe when the model should use this tool.",
  "enabled_by_default": false,
  "timeout_seconds": 30,
  "parameters": {
    "type": "object",
    "properties": {
      "argument": {"type": "string", "description": "Describe this argument."}
    },
    "required": ["argument"]
  }
}`;
  editor.focus();
}

async function reloadExternalTools() {
  try {
    const result = await api('/api/tools/reload', { method: 'POST', body: '{}' });
    state.tools = result.tools || [];
    renderToolToggles(state.current?.settings || {});
    const count = result.errors?.length || 0;
    toast(count ? `Reloaded with ${count} warning${count === 1 ? '' : 's'}` : 'External tools reloaded');
  } catch (error) {
    toast(`Tool reload failed: ${error.message}`);
  }
}

async function registerExternalTool() {
  const editor = $('external-tool-definition');
  const definition = editor?.value?.trim() || '';
  if (!definition) return toast('Paste a JSON or YAML tool definition first.');
  try {
    toast('Registering external tool…');
    const result = await api('/api/tools/external/register', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    });
    state.tools = result.tools || [];
    renderToolToggles(state.current?.settings || {});
    toast(`Registered ${result.tool?.label || result.tool?.name || 'tool'}`);
  } catch (error) {
    console.error('External tool registration failed:', error);
    toast(`Tool not registered: ${error.message}`);
  }
}

function loadManagedPresetIntoSettings() {
  const preset = selectedManagedPreset();
  if (!preset) return toast('Select a preset first.');
  const snapshot = {
    ...(state.current || {}),
    model_id: preset.model_id ?? null,
    settings: JSON.parse(JSON.stringify(preset.settings || state.defaults)),
  };
  fillSettings(snapshot);
  $('settings-model-select').value = preset.model_id ?? '';
  toast('Preset loaded into settings — click Save settings to apply to this chat');
}

async function savePresetAsNew() {
  if (state.generating) return toast('Stop generation before saving a preset.');
  try {
    const name = $('preset-name').value.trim();
    if (!name) return toast('Enter a preset name.');
    const preset = await api('/api/presets', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: $('preset-description').value.trim(),
        model_id: $('settings-model-select').value || null,
        settings: collectSettings(),
      }),
    });
    await refreshPresets(preset.id);
    if ($('preset-select')) $('preset-select').value = preset.id;
    toast(`Preset “${preset.name}” saved`);
  } catch (error) {
    toast(`Preset not saved: ${error.message}`);
  }
}

async function updateSelectedPreset() {
  const preset = selectedManagedPreset();
  if (!preset) return toast('Select a preset first.');
  if (state.generating) return toast('Stop generation before updating a preset.');
  try {
    const updated = await api(`/api/presets/${preset.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('preset-name').value.trim(),
        description: $('preset-description').value.trim(),
        model_id: $('settings-model-select').value || null,
        settings: collectSettings(),
      }),
    });
    await refreshPresets(updated.id);
    toast(`Preset “${updated.name}” updated`);
  } catch (error) {
    toast(`Preset not updated: ${error.message}`);
  }
}

async function deleteSelectedPreset() {
  const preset = selectedManagedPreset();
  if (!preset) return toast('Select a preset first.');
  if (!confirm(`Delete preset “${preset.name}”? Existing chats will not be affected.`)) return;
  try {
    await api(`/api/presets/${preset.id}`, { method: 'DELETE' });
    await refreshPresets();
    if ($('preset-select')?.value === preset.id) $('preset-select').value = '';
    toast('Preset deleted');
  } catch (error) {
    toast(`Preset not deleted: ${error.message}`);
  }
}

function resetToAgentCoreDefaults() {
  if (!state.current) return;
  fillSettings({ ...state.current, settings: JSON.parse(JSON.stringify(state.defaults)) });
  toast('Loaded recommended defaults — click Save settings to apply');
}

async function saveSettings() {
  if (!state.current) return toast('No active conversation.');
  if (state.generating) return toast('Stop generation before changing settings.');

  try {
    const settings = collectSettings();
    const modelValue = $('settings-model-select').value || $('model-select').value || null;
    toast('Saving settings…');

    const updated = await api(`/api/conversations/${state.current.id}/settings`, {
      method: 'POST',
      body: JSON.stringify({
        model_id: modelValue || null,
        settings,
      }),
    });

    state.current = updated;
    $('model-select').value = updated.model_id ?? '';
    $('settings-model-select').value = updated.model_id ?? '';
    fillSettings(updated);
    updateModelDot();
    await refreshConversations();
    closeSettings();
    toast('Settings saved');
  } catch (error) {
    console.error('Settings save failed:', error);
    toast(`Settings not saved: ${error.message}`);
  }
}

async function createChat() {
  if (state.generating) return toast('Stop generation first.');
  const presetId = $('preset-select')?.value || null;
  const modelId = presetId ? null : (state.current?.model_id || state.models[0]?.id || null);
  const conversation = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ model_id: modelId, preset_id: presetId }),
  });
  await refreshConversations();
  await loadConversation(conversation.id);
  if (presetId) {
    const preset = state.presets.find(item => String(item.id) === String(presetId));
    toast(`Started from preset “${preset?.name || 'Preset'}”`);
  }
}

async function deleteCurrentChat() {
  if (!state.current || state.generating) return;
  if (!confirm(`Delete “${state.current.title}”?`)) return;
  await api(`/api/conversations/${state.current.id}`, { method: 'DELETE' });
  state.selectedConversationIds.delete(String(state.current.id));
  state.current = null;
  await refreshConversations();
  closeSettings();
  if (state.conversations.length) await loadConversation(state.conversations[0].id);
  else await createChat();
}

function toggleConversationSelectionMode() {
  if (state.generating) return toast('Stop generation first.');
  state.selectingConversations = !state.selectingConversations;
  if (!state.selectingConversations) state.selectedConversationIds.clear();
  renderConversationList();
}

function toggleSelectAllConversations() {
  const checkbox = $('conversation-select-all');
  if (!checkbox) return;
  state.selectedConversationIds.clear();
  if (checkbox.checked) {
    for (const conversation of state.conversations) {
      state.selectedConversationIds.add(String(conversation.id));
    }
  }
  renderConversationList();
}

async function deleteSelectedConversations() {
  if (state.generating) return toast('Stop generation first.');
  const ids = [...state.selectedConversationIds];
  if (!ids.length) return;

  const label = ids.length === 1 ? 'conversation' : 'conversations';
  if (!confirm(`Delete ${ids.length} selected ${label}? This cannot be undone.`)) return;

  const currentId = state.current?.id ? String(state.current.id) : null;
  const deletingCurrent = currentId && state.selectedConversationIds.has(currentId);

  try {
    const result = await api('/api/conversations', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    });

    state.selectedConversationIds.clear();
    state.selectingConversations = false;
    if (deletingCurrent) state.current = null;

    await refreshConversations();
    closeSettings();

    if (!state.current) {
      if (state.conversations.length) await loadConversation(state.conversations[0].id);
      else await createChat();
    } else {
      renderConversationList();
    }

    toast(`Deleted ${result.deleted ?? ids.length} ${label}.`);
  } catch (error) {
    toast(`Could not delete conversations: ${error.message}`);
  }
}

async function browseModel() {
  if (state.generating) return toast('Stop generation first.');

  const button = $('browse-model-btn');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Browsing…';

  try {
    const result = await api('/api/models/browse', { method: 'POST', body: '{}' });
    if (result.cancelled) return;

    await refreshModels();
    if (result.model && state.current) {
      await setConversationModel(result.model.id);
    }
    toast(result.model ? `Selected ${result.model.name}` : 'Model selected');
  } catch (error) {
    console.error('Model browse failed:', error);
    toast(`Browse failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function addModel() {
  const path = $('model-path-input').value.trim();
  if (!path) return toast('Enter a GGUF file or folder path.');
  try {
    toast('Adding model…');
    const result = await api('/api/models', { method: 'POST', body: JSON.stringify({ path }) });
    await refreshModels();
    const added = result.models || [];
    const last = added.length ? added[added.length - 1] : null;
    if (last && state.current) {
      await setConversationModel(last.id);
    }
    $('model-path-input').value = '';
    toast(`Added ${added.length} model(s)`);
  } catch (error) {
    console.error('Add model failed:', error);
    toast(`Add model failed: ${error.message}`);
  }
}

async function updateTitle() {
  if (!state.current) return;
  const title = $('chat-title').value.trim() || 'New chat';
  try {
    const updated = await api(`/api/conversations/${state.current.id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
    state.current = updated;
    await refreshConversations();
  } catch (error) { toast(error.message); }
}

async function changeTopModel() {
  if (!state.current || state.generating) return;
  const value = $('model-select').value;
  try {
    await setConversationModel(value || null);
    if (state.current?.model_id) toast('Model selected');
  } catch (error) { toast(error.message); }
}

function openSettings() {
  closeMobileSidebar();
  if (state.current) fillSettings(state.current);
  $('settings-panel').classList.add('open');
  $('settings-panel').setAttribute('aria-hidden', 'false');
}
function closeSettings() {
  $('settings-panel').classList.remove('open');
  $('settings-panel').setAttribute('aria-hidden', 'true');
}
function closeMobileSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop')?.classList.remove('visible');
}

function toggleMobileSidebar() {
  const sidebar = $('sidebar');
  const opening = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', opening);
  $('sidebar-backdrop')?.classList.toggle('visible', opening);
}

function autosizeInput() {
  const input = $('message-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

$('preset-manager-select').onchange = populatePresetManagerFields;
$('load-preset-btn').onclick = loadManagedPresetIntoSettings;
$('save-preset-btn').onclick = savePresetAsNew;
$('update-preset-btn').onclick = updateSelectedPreset;
$('delete-preset-btn').onclick = deleteSelectedPreset;
$('new-chat-btn').onclick = createChat;
$('settings-btn').onclick = openSettings;
$('open-settings-btn').onclick = openSettings;
if ($('vram-governor-badge')) $('vram-governor-badge').onclick = () => toast($('vram-governor-badge').dataset.details || $('vram-governor-badge').title || 'VRAM governor');
$('close-settings-btn').onclick = closeSettings;
$('save-settings-btn').onclick = saveSettings;
$('reset-settings-btn').onclick = resetToAgentCoreDefaults;
$('delete-chat-btn').onclick = deleteCurrentChat;
$('conversation-select-btn').onclick = toggleConversationSelectionMode;
$('conversation-select-all').onchange = toggleSelectAllConversations;
$('delete-selected-chats-btn').onclick = deleteSelectedConversations;
$('add-model-btn').onclick = addModel;
$('browse-model-btn').onclick = browseModel;
$('send-btn').onclick = sendMessage;
$('attach-btn').onclick = () => $('attachment-input').click();
$('attachment-input').onchange = (event) => handleAttachmentFiles(event.target.files);
$('stop-btn').onclick = () => api('/api/cancel', { method: 'POST', body: '{}' }).catch(() => {});
$('model-select').onchange = changeTopModel;
$('skill-select').onchange = changeSkillMode;
$('skill-editor-open-btn').onclick = openBrowserOSSkillEditor;
$('skill-why-btn').onclick = openSkillWhyModal;
$('tools-summary-btn').onclick = openSettings;
$('tools_enabled').addEventListener('change', updateToolToggleAvailability);
$('import-tool-file-btn').onclick = chooseExternalToolFile;
$('external-tool-file-input').onchange = (event) => importExternalToolFile(event.target.files?.[0]);
$('tool-template-btn').onclick = loadExternalToolTemplate;
$('reload-tools-btn').onclick = reloadExternalTools;
$('register-tool-btn').onclick = registerExternalTool;
$('settings-model-select').onchange = async () => {
  if (!state.current || state.generating) return;
  try {
    await setConversationModel($('settings-model-select').value || null);
  } catch (error) { toast(error.message); }
};
$('chat-title').onchange = updateTitle;
$('menu-btn').onclick = toggleMobileSidebar;
$('sidebar-backdrop').onclick = closeMobileSidebar;
$('message-input').addEventListener('input', autosizeInput);
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
$('chat-scroll').addEventListener('scroll', () => {
  state.autoScroll = isNearBottom();
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('settings-panel').classList.contains('open')) closeSettings();
  else closeMobileSidebar();
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 900) closeMobileSidebar();
});

bootstrap().then(() => {
  setInterval(refreshRuntimeStatus, 5000);
}).catch(error => toast(error.message));
