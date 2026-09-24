// 1. Supabase Client initialisieren
const SUPABASE_URL = 'https://qawjgxikppiumpptchow.supabase.co' // Aus Settings -> API
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhd2pneGlrcHBpdW1wcHRjaG93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMDc0NDYsImV4cCI6MjEwNTU4MzQ0Nn0.CIhHOS2Zznk9pYbWWTrcqO2A-QWbSSGAJC7TY0UQgTs'     // Aus Settings -> API

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// --- Zustand der App ---
let currentUser = null      // Auth-User (id, email)
let currentProfile = null   // Zeile aus "profiles" (display_name, role, is_blocked)
let profileCache = {}       // id -> display_name, für Realtime-Nachrichten und die Chatliste
let chatChannel = null      // Realtime-Channel für die aktuell geöffnete Ansicht
let recoveryMode = false    // true, solange ein "Passwort vergessen"-Link verarbeitet wird
let groupPreviews = {}      // 'main'/'junge'/'maedchen' -> letzte Nachricht, für die Chatliste
let dmPreviews = {}         // andere Nutzer-ID -> letzte Nachricht, für die Chatliste
let readMarks = {}          // chat_key -> Zeitpunkt der letzten eigenen Lesemarkierung
let unreadCounts = {}        // chat_key -> Anzahl ungelesener Nachrichten, für die Chatliste
let reactionMap = {}        // message_id -> { up, down, mine }, für den gerade offenen Chat

// Welcher Chat ist gerade offen: die Gruppe oder ein Einzelchat mit einer bestimmten Person
let currentRoom = { type: 'group' }

function isAdmin() {
  return currentProfile && currentProfile.role === 'admin'
}

// Kleine, feste Farbpalette für Avatare, damit jeder Nutzer immer dieselbe Farbe bekommt
const AVATAR_COLORS = ['#5b8def', '#3fb98c', '#e2a33d', '#e2665f', '#9d6fe0', '#3fb0c9', '#d16fa8']

function avatarColor(id) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function initialsOf(name) {
  return (name || '?').trim().charAt(0).toUpperCase()
}

// Eigenes Pop-up statt der Browser-Meldung, z. B. zum Bestätigen einer Löschung
let confirmModalCallback = null

function showConfirmModal(text, onConfirm) {
  confirmModalCallback = onConfirm
  document.getElementById('confirm-modal-text').textContent = text
  document.getElementById('confirm-modal').style.display = 'flex'
}

function confirmModalYes() {
  document.getElementById('confirm-modal').style.display = 'none'
  const callback = confirmModalCallback
  confirmModalCallback = null
  if (callback) callback()
}

function confirmModalNo() {
  document.getElementById('confirm-modal').style.display = 'none'
  confirmModalCallback = null
}

// Dunkler/heller Modus, gespeichert im Browser (nur auf diesem Gerät)
function applyStoredTheme() {
  const stored = localStorage.getItem('theme')
  const isLight = stored === 'light'
  document.body.classList.toggle('light-theme', isLight)
  const toggle = document.getElementById('dark-mode-toggle')
  if (toggle) toggle.checked = !isLight
}

function toggleDarkMode() {
  const toggle = document.getElementById('dark-mode-toggle')
  const wantsDark = toggle.checked
  document.body.classList.toggle('light-theme', !wantsDark)
  localStorage.setItem('theme', wantsDark ? 'dark' : 'light')
}

applyStoredTheme()

// 2. Start: gespeicherte Session prüfen (Auto-Login nach Neuladen),
//    oder erkennen, dass gerade ein "Passwort vergessen"-Link geöffnet wurde
async function init() {
  supabaseClient.auth.onAuthStateChange((event) => {
    // Im Callback keine Supabase-Aufrufe mit await (kann die Auth-Library blockieren)
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true
      showPasswordReset()
    } else if (event === 'SIGNED_OUT' && !recoveryMode) {
      setTimeout(showLogin, 0)
    }
  })

  const { data: { session } } = await supabaseClient.auth.getSession()
  if (recoveryMode) return // die Weiche oben zeigt bereits den Reset-Bildschirm

  if (session) {
    await enterApp(session.user)
  } else {
    showLogin()
  }
}

function hideAllScreens() {
  document.getElementById('login-bereich').style.display = 'none'
  document.getElementById('forgot-bereich').style.display = 'none'
  document.getElementById('reset-bereich').style.display = 'none'
  document.getElementById('list-bereich').style.display = 'none'
  document.getElementById('settings-bereich').style.display = 'none'
  document.getElementById('email-change-bereich').style.display = 'none'
  document.getElementById('password-change-bereich').style.display = 'none'
  document.getElementById('admin-contacts-bereich').style.display = 'none'
  document.getElementById('conversation-bereich').style.display = 'none'
}

// Login-Ansicht anzeigen und alles Nutzerbezogene aufräumen
function showLogin() {
  stopListening()
  currentUser = null
  currentProfile = null
  profileCache = {}

  document.getElementById('username').value = ''
  document.getElementById('password').value = ''
  hideAllScreens()
  document.getElementById('login-bereich').style.display = 'block'
}

function showPasswordReset() {
  hideAllScreens()
  document.getElementById('reset-bereich').style.display = 'block'
}

// Chatliste anzeigen (Startbildschirm nach dem Login): lädt Profil + Nutzerliste
async function enterApp(user) {
  const { data: profile, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, role, is_blocked, gender')
    .eq('id', user.id)
    .single()

  if (error || !profile) {
    alert('Dein Profil konnte nicht geladen werden.')
    await supabaseClient.auth.signOut()
    showLogin()
    return
  }

  if (profile.is_blocked) {
    alert('Dein Zugang wurde gesperrt. Bitte wende dich an die Leitung.')
    await supabaseClient.auth.signOut()
    showLogin()
    return
  }

  currentUser = user
  currentProfile = profile

  document.getElementById('user-display-name').innerText =
    profile.display_name || (user.email ? user.email.split('@')[0] : 'Nutzer')

  stopListening()
  hideAllScreens()
  document.getElementById('list-bereich').style.display = 'block'
  document.getElementById('chat-list').innerHTML = '<p class="chat-empty">Lädt …</p>'

  await loadProfileCache()
  await renderChatList()
  listenForListUpdates()
}

// Letzte Nachricht je Chat laden, für die Vorschau in der Liste
async function loadChatPreviews() {
  groupPreviews = {}
  dmPreviews = {}
  unreadCounts = {}

  const { data: markRows } = await supabaseClient
    .from('read_marks')
    .select('chat_key, last_read_at')
    .eq('user_id', currentUser.id)

  readMarks = {}
  ;(markRows || []).forEach(m => { readMarks[m.chat_key] = new Date(m.last_read_at) })

  function countIfUnread(key, row) {
    if (row.sender_id === currentUser.id) return
    const lastRead = readMarks[key]
    if (!lastRead || new Date(row.created_at) > lastRead) {
      unreadCounts[key] = (unreadCounts[key] || 0) + 1
    }
  }

  const { data: groupRows } = await supabaseClient
    .from('messages')
    .select('text, created_at, group_key, sender_id')
    .order('created_at', { ascending: false })
    .limit(300)

  if (groupRows) {
    groupRows.forEach(row => {
      const key = row.group_key || 'main'
      if (!groupPreviews[key]) groupPreviews[key] = row
      countIfUnread(key, row)
    })
  }

  const { data: dmRows } = await supabaseClient
    .from('direct_messages')
    .select('text, created_at, sender_id, recipient_id')
    .order('created_at', { ascending: false })
    .limit(400)

  if (dmRows) {
    dmRows.forEach(row => {
      const other = row.sender_id === currentUser.id ? row.recipient_id : row.sender_id
      if (!dmPreviews[other]) dmPreviews[other] = row
      countIfUnread('dm:' + other, row)
    })
  }
}

// Welchen Schlüssel ein Chat für die Lesemarkierung hat (kein Schlüssel = wird nicht mitgezählt,
// z. B. wenn der Admin sich fremde Einzelchats nur ansieht)
function chatKeyForRoom(room) {
  if (room.type === 'dm') return 'dm:' + room.userId
  if (room.type === 'group') return room.groupKey || 'main'
  return null
}

// Merkt sich, dass der gerade offene Chat bis jetzt gelesen wurde
async function markCurrentRoomRead() {
  const key = chatKeyForRoom(currentRoom)
  if (!key) return

  await supabaseClient.from('read_marks').upsert({
    user_id: currentUser.id,
    chat_key: key,
    last_read_at: new Date().toISOString()
  })
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

// Baut den Inhalt eines Listeneintrags: Avatar, Name, Vorschau-Text, Uhrzeit, Ungelesen-Zähler
function chatListItemHTML(avatarHTML, name, preview, unreadCount) {
  const previewText = preview ? truncate(preview.text, 34) : 'Noch keine Nachrichten'
  const timeText = preview ? formatTime(preview.created_at) : ''
  const badge = unreadCount > 0
    ? `<span class="unread-badge">${unreadCount > 9 ? '9+' : unreadCount}</span>`
    : ''
  return `
    ${avatarHTML}
    <div class="chat-list-text">
      <div class="chat-list-name">${escapeHTML(name)}</div>
      <div class="chat-list-preview">${escapeHTML(previewText)}</div>
    </div>
    <div class="chat-list-time-badge">
      <div class="chat-list-time">${timeText}</div>
      ${badge}
    </div>
  `
}

// Chatliste zusammenbauen: Gruppe angeheftet, danach alle anderen Nutzer
async function renderChatList() {
  await loadChatPreviews()

  const list = document.getElementById('chat-list')
  list.innerHTML = ''

  const groupItem = document.createElement('li')
  groupItem.className = 'chat-list-item pinned'
  groupItem.innerHTML = chatListItemHTML(
    '<div class="chat-list-avatar group-avatar">📌</div>',
    'JungscharChat',
    groupPreviews['main'],
    unreadCounts['main']
  )
  groupItem.addEventListener('click', openGroupChat)
  list.appendChild(groupItem)

  if (isAdmin() || currentProfile.gender === 'junge') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned'
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👦</div>',
      'Jungs',
      groupPreviews['junge'],
      unreadCounts['junge']
    )
    item.addEventListener('click', () => openGenderGroup('junge', 'Jungs'))
    list.appendChild(item)
  }

  if (isAdmin() || currentProfile.gender === 'maedchen') {
    const item = document.createElement('li')
    item.className = 'chat-list-item pinned'
    item.innerHTML = chatListItemHTML(
      '<div class="chat-list-avatar group-avatar">👧</div>',
      'Mädels',
      groupPreviews['maedchen'],
      unreadCounts['maedchen']
    )
    item.addEventListener('click', () => openGenderGroup('maedchen', 'Mädels'))
    list.appendChild(item)
  }

  const others = Object.entries(profileCache)
    .filter(([id, info]) => id !== currentUser.id && info.role !== 'admin')
    .sort((a, b) => {
      const timeA = dmPreviews[a[0]] ? new Date(dmPreviews[a[0]].created_at).getTime() : 0
      const timeB = dmPreviews[b[0]] ? new Date(dmPreviews[b[0]].created_at).getTime() : 0
      if (timeA !== timeB) return timeB - timeA
      return (a[1].name || '').localeCompare(b[1].name || '')
    })

  others.forEach(([id, info]) => {
    const name = info.name
    const item = document.createElement('li')
    item.className = 'chat-list-item'
    item.innerHTML = chatListItemHTML(
      `<div class="chat-list-avatar" style="background:${avatarColor(id)}">${initialsOf(name)}</div>`,
      name || 'Ohne Namen',
      dmPreviews[id],
      unreadCounts['dm:' + id]
    )
    item.addEventListener('click', () => {
      if (isAdmin()) openAdminContactsFor(id, name)
      else openDirectChat(id, name)
    })
    list.appendChild(item)
  })

  if (others.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'chat-empty'
    hint.textContent = 'Noch keine anderen Mitglieder da.'
    list.appendChild(hint)
  }
}

// Nötig, weil die Namen in der Chatliste per innerHTML gesetzt werden
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  )
}

function openGroupChat() {
  currentRoom = { type: 'group', groupKey: null }
  openConversation('JungscharChat')
}

function openGenderGroup(groupKey, title) {
  currentRoom = { type: 'group', groupKey: groupKey }
  openConversation(title)
}

function openDirectChat(userId, name) {
  currentRoom = { type: 'dm', userId: userId, name: name || 'Ohne Namen' }
  openConversation(name || 'Ohne Namen')
}

// Admin: Liste der Einzelchat-Partner einer bestimmten Person laden (rein lesend)
async function openAdminContactsFor(userId, name) {
  stopListening()
  document.getElementById('admin-contacts-title').textContent = name || 'Ohne Namen'
  hideAllScreens()
  document.getElementById('admin-contacts-bereich').style.display = 'block'

  const list = document.getElementById('admin-contacts-list')
  list.innerHTML = '<p class="chat-empty">Lädt …</p>'

  const { data: rows, error } = await supabaseClient
    .from('direct_messages')
    .select('sender_id, recipient_id, text, created_at')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order('created_at', { ascending: false })

  list.innerHTML = ''

  if (error) {
    list.textContent = 'Fehler beim Laden: ' + error.message
    return
  }

  // Pro Gesprächspartner nur die jeweils neueste Nachricht merken
  // (rows ist schon neu -> alt sortiert, also zählt der erste Treffer)
  const partners = {}
  rows.forEach(r => {
    const partnerId = r.sender_id === userId ? r.recipient_id : r.sender_id
    if (!partners[partnerId]) partners[partnerId] = r
  })

  const entries = Object.entries(partners)

  if (entries.length === 0) {
    list.innerHTML = '<p class="chat-empty">Noch keine Einzelchats.</p>'
    return
  }

  entries.forEach(([partnerId, preview]) => {
    const partnerName = (profileCache[partnerId] && profileCache[partnerId].name) || 'Unbekannt'
    const item = document.createElement('li')
    item.className = 'chat-list-item'
    item.innerHTML = chatListItemHTML(
      `<div class="chat-list-avatar" style="background:${avatarColor(partnerId)}">${initialsOf(partnerName)}</div>`,
      partnerName,
      preview
    )
    item.addEventListener('click', () => openAdminDmView(userId, partnerId, name, partnerName))
    list.appendChild(item)
  })
}

// Admin: den Einzelchat zwischen zwei anderen Personen rein lesend öffnen
function openAdminDmView(userA, userB, nameA, nameB) {
  currentRoom = { type: 'dm-view', userA: userA, userB: userB }
  openConversation(nameA + ' ↔ ' + nameB)
}

async function openConversation(title) {
  document.getElementById('conversation-title').textContent = title
  hideAllScreens()
  document.getElementById('conversation-bereich').style.display = 'block'
  cancelEditingMessage()

  // Admins lesen überall mit, schreiben aber nirgends
  document.querySelector('.chat-input-area').style.display = isAdmin() ? 'none' : 'flex'

  await loadMessages()
  listenForNewMessages()
  markCurrentRoomRead()
}

// Zurück zur Chatliste (wird vom Zurück-Pfeil im HTML als showList() aufgerufen)
function showList() {
  stopListening()
  hideAllScreens()
  document.getElementById('list-bereich').style.display = 'block'
  renderChatList().then(listenForListUpdates) // Namen und Vorschauen könnten sich zwischenzeitlich geändert haben
}

// 3. Einloggen
async function login() {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value

  if (!username || !password) {
    alert('Bitte Benutzername und Passwort eingeben!')
    return
  }

  const loginBtn = document.getElementById('login-btn')
  loginBtn.disabled = true

  // Benutzername -> hinterlegte E-Mail-Adresse (über eine Datenbankfunktion,
  // damit im Frontend nicht einfach alle E-Mails abgefragt werden können)
  const { data: email, error: lookupError } = await supabaseClient
    .rpc('get_email_by_username', { uname: username })

  if (lookupError || !email) {
    loginBtn.disabled = false
    alert('Nutzername nicht gefunden.')
    return
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  })

  loginBtn.disabled = false

  if (error) {
    if (error.message.includes('Email not confirmed')) {
      alert('Das Konto wurde noch nicht bestätigt.')
    } else {
      alert('Falsches Passwort.')
    }
    return
  }

  await enterApp(data.user)
}

function togglePasswordVisibility() {
  const input = document.getElementById('password')
  const btn = document.querySelector('.toggle-password')
  const willShow = input.type === 'password'
  input.type = willShow ? 'text' : 'password'
  btn.setAttribute('aria-label', willShow ? 'Passwort verbergen' : 'Passwort anzeigen')
}

function showForgotScreen() {
  hideAllScreens()
  document.getElementById('forgot-bereich').style.display = 'block'
}

// 4. Namen aller Profile einmal laden (für die Chatliste und für Realtime-Nachrichten ohne Join)
async function loadProfileCache() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, role')

  if (error) {
    console.error('Fehler beim Laden der Profile:', error)
    return
  }

  profileCache = {}
  data.forEach(p => { profileCache[p.id] = { name: p.display_name, role: p.role } })
}

async function fetchProfileName(userId) {
  const { data } = await supabaseClient
    .from('profiles')
    .select('display_name, role')
    .eq('id', userId)
    .single()

  if (data) profileCache[userId] = { name: data.display_name, role: data.role }
}

// Ob gerade ein Einzelchat offen ist - entweder der eigene, oder (Admin) der fremd eingesehene
function isDmRoom() {
  return currentRoom.type === 'dm' || currentRoom.type === 'dm-view'
}

// Name der Tabelle, je nachdem ob gerade die Gruppe oder ein Einzelchat offen ist
function currentTable() {
  return isDmRoom() ? 'direct_messages' : 'messages'
}

// Wessen Sicht gerade eingenommen wird: normalerweise man selbst, beim Admin-Einblick
// in einen fremden Einzelchat die Person, auf die der Admin geklickt hat
function perspectiveUserId() {
  return currentRoom.type === 'dm-view' ? currentRoom.userA : currentUser.id
}

// 5. Nachrichten aus der Datenbank laden
async function loadMessages() {
  let query = supabaseClient
    .from(currentTable())
    .select('*, profiles!sender_id(display_name)')
    .order('created_at', { ascending: true })

  if (currentRoom.type === 'dm') {
    const me = currentUser.id
    const other = currentRoom.userId
    query = query.or(
      `and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`
    )
  } else if (currentRoom.type === 'dm-view') {
    const a = currentRoom.userA
    const b = currentRoom.userB
    query = query.or(
      `and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`
    )
  } else if (currentRoom.groupKey) {
    query = query.eq('group_key', currentRoom.groupKey)
  } else {
    query = query.is('group_key', null)
  }

  const { data: messages, error } = await query

  if (error) {
    console.error('Fehler beim Laden:', error)
    return
  }

  const chatBox = document.getElementById('chat-box')
  chatBox.innerHTML = ''

  if (messages.length === 0) {
    reactionMap = {}
    showEmptyHint()
    return
  }

  reactionMap = await loadReactionsFor(messages.map(m => m.id))
  messages.forEach(msg => renderMessage(msg))
  chatBox.scrollTop = chatBox.scrollHeight
}

// Reaktionen (Daumen hoch/runter) zu einer Liste von Nachrichten-IDs laden
async function loadReactionsFor(ids) {
  const map = {}
  if (!ids || ids.length === 0) return map

  const table = isDmRoom() ? 'dm_reactions' : 'message_reactions'
  const { data } = await supabaseClient
    .from(table)
    .select('message_id, emoji, user_id')
    .in('message_id', ids)

  ;(data || []).forEach(r => {
    if (!map[r.message_id]) map[r.message_id] = { counts: {}, mine: null }
    map[r.message_id].counts[r.emoji] = (map[r.message_id].counts[r.emoji] || 0) + 1
    if (r.user_id === currentUser.id) map[r.message_id].mine = r.emoji
  })

  return map
}

function showEmptyHint() {
  const hint = document.createElement('p')
  hint.className = 'chat-empty'
  hint.textContent = 'Noch keine Nachrichten. Schreib die erste!'
  document.getElementById('chat-box').appendChild(hint)
}

// Zeitstempel: heute nur Uhrzeit, gestern mit "Gestern", sonst Datum
function formatTime(isoString) {
  const d = new Date(isoString)
  const now = new Date()
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

  if (d.toDateString() === now.toDateString()) return time

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern, ' + time

  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return date + ', ' + time
}

// Eine Nachricht als Element in den Chat einfügen
// (textContent statt innerHTML: Namen und Text können kein HTML einschleusen)
function renderMessage(msg) {
  const chatBox = document.getElementById('chat-box')

  // Doppelte vermeiden (z. B. wenn Realtime und Laden sich überschneiden)
  if (chatBox.querySelector(`[data-id="${msg.id}"]`)) return

  const emptyHint = chatBox.querySelector('.chat-empty')
  if (emptyHint) emptyHint.remove()

  const isOwn = msg.sender_id === perspectiveUserId()
  const author =
    (msg.profiles && msg.profiles.display_name) ||
    (profileCache[msg.sender_id] && profileCache[msg.sender_id].name) ||
    'Unbekannt'

  const row = document.createElement('div')
  row.className = 'msg-row ' + (isOwn ? 'own' : 'other')
  row.dataset.id = msg.id

  if (!isOwn) {
    const avatar = document.createElement('div')
    avatar.className = 'msg-avatar'
    avatar.style.background = avatarColor(msg.sender_id)
    avatar.textContent = initialsOf(author)
    row.appendChild(avatar)
  }

  const msgElement = document.createElement('div')
  msgElement.className = 'msg ' + (isOwn ? 'own' : 'other')

  const meta = document.createElement('div')
  meta.className = 'msg-meta'

  // Im Einzelchat kennt man den Absender schon durch den Titel oben, im Gruppenchat nicht
  if (!isOwn && currentRoom.type === 'group') {
    const authorEl = document.createElement('span')
    authorEl.className = 'msg-author'
    authorEl.textContent = author
    meta.appendChild(authorEl)
  }

  const timeEl = document.createElement('span')
  timeEl.className = 'msg-time'
  timeEl.textContent = formatTime(msg.created_at)
  meta.appendChild(timeEl)

  if (msg.edited_at) {
    const editedTag = document.createElement('span')
    editedTag.className = 'msg-edited'
    editedTag.textContent = '(bearbeitet)'
    meta.appendChild(editedTag)
  }

  // Drei-Punkte-Menü: Inhalt hängt davon ab, wem die Nachricht gehört
  const canEdit = isOwn && !isAdmin()
  const canDelete = isOwn || isAdmin()
  const canReact = !isAdmin()

  if (canEdit || canDelete || canReact) {
    const menuBtn = document.createElement('button')
    menuBtn.className = 'msg-menu-btn'
    menuBtn.title = 'Optionen'
    menuBtn.setAttribute('aria-label', 'Optionen')
    menuBtn.textContent = '⋮'
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openMessageMenu(menuBtn, msg, { canEdit, canDelete, canReact })
    })
    msgElement.appendChild(menuBtn)
  }

  const textEl = document.createElement('div')
  textEl.className = 'msg-text'
  textEl.textContent = msg.text

  const reactRow = document.createElement('div')
  reactRow.className = 'msg-reactions'
  renderReactionChips(reactRow, msg.id)

  msgElement.appendChild(meta)
  msgElement.appendChild(textEl)
  msgElement.appendChild(reactRow)
  row.appendChild(msgElement)

  // Nur nach unten scrollen, wenn man schon unten war (oder selbst schreibt)
  const nearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80
  chatBox.appendChild(row)
  if (nearBottom || isOwn) chatBox.scrollTop = chatBox.scrollHeight
}

// Reaktions-Chips unter einer Nachricht neu aufbauen (ein Chip pro benutztem Emoji)
function renderReactionChips(container, messageId) {
  container.innerHTML = ''
  const info = reactionMap[messageId] || { counts: {}, mine: null }

  Object.entries(info.counts).forEach(([emoji, count]) => {
    if (count <= 0) return
    const chip = document.createElement('button')
    chip.className = 'reaction-btn' + (info.mine === emoji ? ' active' : '')
    chip.textContent = emoji + ' ' + count
    chip.addEventListener('click', () => toggleReaction(messageId, emoji))
    container.appendChild(chip)
  })
}

// Die Emoji, die im Reagieren-Menü zur Auswahl stehen
const QUICK_EMOJI = ['👍', '👎', '❤️', '😂', '😮', '😢', '🙏']

let openMenuEl = null

function closeMessageMenu() {
  if (openMenuEl) {
    openMenuEl.remove()
    openMenuEl = null
  }
}

document.addEventListener('click', closeMessageMenu)

// Öffnet das Drei-Punkte-Menü neben einer Nachricht
function openMessageMenu(anchorBtn, msg, options) {
  closeMessageMenu()

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  function showMainOptions() {
    menu.innerHTML = ''

    if (options.canReact) {
      const reactItem = document.createElement('button')
      reactItem.className = 'msg-menu-item'
      reactItem.textContent = 'Reagieren'
      reactItem.addEventListener('click', showEmojiPicker)
      menu.appendChild(reactItem)
    }

    if (options.canEdit) {
      const editItem = document.createElement('button')
      editItem.className = 'msg-menu-item'
      editItem.textContent = 'Bearbeiten'
      editItem.addEventListener('click', () => {
        closeMessageMenu()
        startEditingMessage(msg.id, msg.text)
      })
      menu.appendChild(editItem)
    }

    if (options.canDelete) {
      const delItem = document.createElement('button')
      delItem.className = 'msg-menu-item danger'
      delItem.textContent = 'Löschen'
      delItem.addEventListener('click', () => {
        closeMessageMenu()
        deleteMessage(msg.id)
      })
      menu.appendChild(delItem)
    }
  }

  function showEmojiPicker() {
    menu.innerHTML = ''
    const picker = document.createElement('div')
    picker.className = 'emoji-picker'
    QUICK_EMOJI.forEach(emoji => {
      const btn = document.createElement('button')
      btn.className = 'emoji-picker-btn'
      btn.textContent = emoji
      btn.addEventListener('click', () => {
        closeMessageMenu()
        toggleReaction(msg.id, emoji)
      })
      picker.appendChild(btn)
    })
    menu.appendChild(picker)
  }

  showMainOptions()
  anchorBtn.parentElement.appendChild(menu)
  openMenuEl = menu
}

// 6. Neue Nachricht senden (Gruppe oder Einzelchat)
async function sendMessage() {
  const input = document.getElementById('message-input')
  const sendBtn = document.getElementById('send-btn')
  const text = input.value.trim()

  if (!text || !currentUser) return

  if (editingMessageId) {
    await saveEditedMessage(text)
    return
  }

  sendBtn.disabled = true

  const row = { sender_id: currentUser.id, text: text }
  if (currentRoom.type === 'dm') row.recipient_id = currentRoom.userId
  else row.group_key = currentRoom.groupKey || null

  // .select() liefert die neue Zeile zurück, damit sie sofort angezeigt werden kann
  const { data: inserted, error } = await supabaseClient
    .from(currentTable())
    .insert([row])
    .select('*, profiles!sender_id(display_name)')
    .single()

  sendBtn.disabled = false

  if (error) {
    await handleSendError(error)
  } else {
    renderMessage(inserted)
    input.value = ''
    input.focus()
  }
}

// Wenn Senden fehlschlägt: prüfen, ob der Grund eine Sperre ist
async function handleSendError(error) {
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('is_blocked')
    .eq('id', currentUser.id)
    .single()

  if (profile && profile.is_blocked) {
    alert('Dein Zugang wurde gesperrt.')
    await logout()
  } else {
    alert('Fehler beim Senden: ' + error.message)
  }
}

// 7. Live-Updates für den gerade offenen Chat (Echtzeit)
function listenForNewMessages() {
  stopListening()
  const table = currentTable()
  const roomKey =
    currentRoom.type === 'dm-view' ? currentRoom.userA + '-' + currentRoom.userB
    : (currentRoom.userId || currentRoom.groupKey || 'main')

  chatChannel = supabaseClient
    .channel('room:' + table + ':' + roomKey)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: table }, async (payload) => {
      if (!belongsToCurrentRoom(payload.new)) return
      const msg = payload.new
      if (!profileCache[msg.sender_id]) await fetchProfileName(msg.sender_id)
      renderMessage(msg)
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: table }, (payload) => {
      if (!belongsToCurrentRoom(payload.new)) return
      updateMessageElement(payload.new)
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: table }, (payload) => {
      removeMessageElement(payload.old.id)
    })
    .subscribe()
}

function stopListening() {
  if (chatChannel) {
    supabaseClient.removeChannel(chatChannel)
    chatChannel = null
  }
}

// Solange die Chatliste offen ist: bei jeder neuen Nachricht (egal wo) neu sortieren
// und die Vorschauen/Zähler auffrischen
function listenForListUpdates() {
  stopListening()
  chatChannel = supabaseClient
    .channel('list-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
      renderChatList()
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, () => {
      renderChatList()
    })
    .subscribe()
}

// Prüft, ob eine per Realtime hereinkommende Zeile zum gerade geöffneten Chat gehört
function belongsToCurrentRoom(row) {
  if (currentRoom.type === 'group') {
    return (row.group_key || null) === (currentRoom.groupKey || null)
  }
  if (currentRoom.type === 'dm-view') {
    const a = currentRoom.userA
    const b = currentRoom.userB
    return (
      (row.sender_id === a && row.recipient_id === b) ||
      (row.sender_id === b && row.recipient_id === a)
    )
  }
  const me = currentUser.id
  const other = currentRoom.userId
  return (
    (row.sender_id === me && row.recipient_id === other) ||
    (row.sender_id === other && row.recipient_id === me)
  )
}

function removeMessageElement(id) {
  const el = document.querySelector(`#chat-box [data-id="${id}"]`)
  if (el) el.remove()
}

// Reaktion setzen, wechseln oder wieder entfernen (ein Klick auf die bereits aktive schaltet sie aus)
async function toggleReaction(messageId, emoji) {
  const table = isDmRoom() ? 'dm_reactions' : 'message_reactions'
  const info = reactionMap[messageId] || { counts: {}, mine: null }

  if (info.mine === emoji) {
    await supabaseClient
      .from(table)
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', currentUser.id)
      .eq('emoji', emoji)
  } else {
    if (info.mine) {
      await supabaseClient
        .from(table)
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', currentUser.id)
        .eq('emoji', info.mine)
    }
    await supabaseClient
      .from(table)
      .insert([{ message_id: messageId, user_id: currentUser.id, emoji: emoji }])
  }

  const updated = await loadReactionsFor([messageId])
  reactionMap[messageId] = updated[messageId] || { counts: {}, mine: null }

  const row = document.querySelector(`#chat-box [data-id="${messageId}"] .msg-reactions`)
  if (row) renderReactionChips(row, messageId)
}

// Eigene Nachricht bearbeiten: der Text wandert unten ins Eingabefeld,
// "Senden" wird währenddessen zu "Speichern" (wie bei WhatsApp)
let editingMessageId = null

function startEditingMessage(id, oldText) {
  editingMessageId = id
  const input = document.getElementById('message-input')
  input.value = oldText
  input.focus()
  document.getElementById('edit-bar').style.display = 'flex'
  document.getElementById('send-btn').textContent = 'Speichern'
}

function cancelEditingMessage() {
  editingMessageId = null
  document.getElementById('message-input').value = ''
  document.getElementById('edit-bar').style.display = 'none'
  document.getElementById('send-btn').textContent = 'Senden'
}

async function saveEditedMessage(newText) {
  const id = editingMessageId
  const input = document.getElementById('message-input')

  const { data, error } = await supabaseClient
    .from(currentTable())
    .update({ text: newText, edited_at: new Date().toISOString() })
    .eq('id', id)
    .select()

  if (error) {
    alert('Bearbeiten fehlgeschlagen: ' + error.message)
  } else if (!data || data.length === 0) {
    alert('Bearbeiten nicht erlaubt.')
  } else {
    updateMessageElement(data[0])
    cancelEditingMessage()
    return
  }

  input.value = newText
}

// Text (und ggf. den "bearbeitet"-Hinweis) einer bereits angezeigten Nachricht aktualisieren
function updateMessageElement(msg) {
  const row = document.querySelector(`#chat-box [data-id="${msg.id}"]`)
  if (!row) return

  const textEl = row.querySelector('.msg-text')
  if (textEl) textEl.textContent = msg.text

  if (msg.edited_at && !row.querySelector('.msg-edited')) {
    const meta = row.querySelector('.msg-meta')
    const tag = document.createElement('span')
    tag.className = 'msg-edited'
    tag.textContent = '(bearbeitet)'
    meta.appendChild(tag)
  }
}

// 8. Nachricht löschen (eigene Nachricht oder, als Admin, jede Nachricht)
function deleteMessage(id) {
  showConfirmModal('Diese Nachricht wirklich löschen?', async () => {
    // .select() liefert die gelöschten Zeilen zurück; leer = keine Berechtigung (RLS)
    const { data, error } = await supabaseClient
      .from(currentTable())
      .delete()
      .eq('id', id)
      .select()

    if (error) {
      alert('Löschen fehlgeschlagen: ' + error.message)
    } else if (!data || data.length === 0) {
      alert('Löschen nicht erlaubt.')
    } else {
      removeMessageElement(id)
    }
  })
}

// 9. Einstellungen: eigener Bildschirm. Eigenes Passwort ändern für alle,
//    bei Admins zusätzlich die Nutzerverwaltung darunter.
function openSettings() {
  stopListening()
  hideAllScreens()
  document.getElementById('settings-bereich').style.display = 'block'

  const adminSection = document.getElementById('admin-settings-section')
  if (isAdmin()) {
    adminSection.style.display = 'block'
    loadUsers()
  } else {
    adminSection.style.display = 'none'
  }
}

function openEmailChange() {
  hideAllScreens()
  document.getElementById('email-change-bereich').style.display = 'block'
  document.getElementById('current-email-display').value = currentUser.email || ''
  document.getElementById('new-email').value = ''
}

function openPasswordChange() {
  hideAllScreens()
  document.getElementById('password-change-bereich').style.display = 'block'
  document.getElementById('old-password').value = ''
  document.getElementById('new-password').value = ''
  document.getElementById('repeat-password').value = ''
}

// Zeigt/versteckt den Inhalt eines Passwortfelds über das zugehörige Augen-Symbol
function toggleFieldVisibility(inputId, btn) {
  const input = document.getElementById(inputId)
  const willShow = input.type === 'password'
  input.type = willShow ? 'text' : 'password'
  btn.setAttribute('aria-label', willShow ? 'Passwort verbergen' : 'Passwort anzeigen')
}

async function sendPasswordReset() {
  const username = document.getElementById('forgot-username').value.trim()

  if (!username) {
    alert('Bitte trage deinen Benutzernamen ein.')
    return
  }

  const btn = document.getElementById('forgot-send-btn')
  btn.disabled = true

  const { data: email, error: lookupError } = await supabaseClient
    .rpc('get_email_by_username', { uname: username })

  if (lookupError || !email) {
    btn.disabled = false
    alert('Dieser Benutzername ist uns nicht bekannt.')
    return
  }

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href.split('#')[0].split('?')[0]
  })

  btn.disabled = false

  if (error) {
    alert('Fehler: ' + error.message)
  } else {
    alert('Ein Link zum Zurücksetzen wurde an die hinterlegte E-Mail-Adresse geschickt. Bitte auch den Spam-Ordner prüfen.')
    showLogin()
  }
}

// Eigene E-Mail-Adresse ändern (der Benutzername bleibt dabei unverändert,
// er wird nur beim Anlegen eines Kontos einmalig aus der E-Mail abgeleitet)
async function changeEmail() {
  const input = document.getElementById('new-email')
  const newEmail = input.value.trim()

  if (!newEmail) {
    alert('Bitte eine neue E-Mail-Adresse eingeben.')
    return
  }

  const btn = document.getElementById('change-email-btn')
  btn.disabled = true

  const { error } = await supabaseClient.auth.updateUser({ email: newEmail })

  btn.disabled = false

  if (error) {
    alert('Fehler beim Ändern: ' + error.message)
  } else {
    input.value = ''
    alert('Prüf-Link wurde an die neue Adresse geschickt. Erst nach dem Bestätigen gilt die Änderung.')
    openSettings()
  }
}

// Ein einfacher Mindeststandard: 8+ Zeichen, mindestens ein Buchstabe und eine Zahl
function isStrongPassword(pw) {
  return pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw)
}

async function changePassword() {
  const oldPassword = document.getElementById('old-password').value
  const newPassword = document.getElementById('new-password').value
  const repeatPassword = document.getElementById('repeat-password').value

  if (!oldPassword) {
    alert('Bitte dein aktuelles Passwort eingeben.')
    return
  }

  if (!isStrongPassword(newPassword)) {
    alert('Das neue Passwort muss mindestens 8 Zeichen haben, mit Buchstaben und einer Zahl.')
    return
  }

  if (newPassword !== repeatPassword) {
    alert('Die Wiederholung stimmt nicht mit dem neuen Passwort überein.')
    return
  }

  const btn = document.getElementById('change-password-btn')
  btn.disabled = true

  // Altes Passwort bestätigen, bevor das neue gesetzt wird
  const { error: checkError } = await supabaseClient.auth.signInWithPassword({
    email: currentUser.email,
    password: oldPassword
  })

  if (checkError) {
    btn.disabled = false
    alert('Das aktuelle Passwort ist falsch.')
    return
  }

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword })

  btn.disabled = false

  if (error) {
    alert('Fehler beim Ändern: ' + error.message)
  } else {
    document.getElementById('old-password').value = ''
    document.getElementById('new-password').value = ''
    document.getElementById('repeat-password').value = ''
    alert('Passwort wurde geändert.')
    openSettings()
  }
}

// Nach Klick auf den Link aus der "Passwort vergessen"-E-Mail: neues Passwort setzen,
// bis dahin ist nichts anderes möglich als genau das
async function completePasswordReset() {
  const input = document.getElementById('reset-password')
  const newPassword = input.value

  if (newPassword.length < 6) {
    alert('Das Passwort muss mindestens 6 Zeichen haben.')
    return
  }

  const btn = document.getElementById('reset-password-btn')
  btn.disabled = true

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword })

  btn.disabled = false

  if (error) {
    alert('Fehler beim Setzen des Passworts: ' + error.message)
    return
  }

  recoveryMode = false
  alert('Passwort gesetzt. Du bist jetzt eingeloggt.')

  const { data: { user } } = await supabaseClient.auth.getUser()
  if (user) await enterApp(user)
  else showLogin()
}

// 10. Admin: Nutzerverwaltung
async function loadUsers() {
  const list = document.getElementById('user-list')

  const { data: users, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, role, is_blocked, gender')
    .order('display_name')

  if (error) {
    list.textContent = 'Nutzer konnten nicht geladen werden: ' + error.message
    return
  }

  list.innerHTML = ''

  users
    .filter(u => u.id !== currentUser.id)
    .forEach(u => {
      const row = document.createElement('li')
      row.className = 'user-row' + (u.is_blocked ? ' blocked' : '')

      const name = document.createElement('span')
      name.className = 'user-name'
      name.textContent = u.display_name || 'Ohne Namen'
      row.appendChild(name)

      const genderToggle = document.createElement('div')
      genderToggle.className = 'gender-toggle'
      genderToggle.innerHTML = `
        <button type="button" class="gender-option${u.gender === 'junge' ? ' active' : ''}" data-value="junge">Junge</button>
        <button type="button" class="gender-option${u.gender === 'maedchen' ? ' active' : ''}" data-value="maedchen">Mädchen</button>
      `
      genderToggle.querySelectorAll('.gender-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const isActive = btn.classList.contains('active')
          setGender(u.id, isActive ? null : btn.dataset.value)
        })
      })
      row.appendChild(genderToggle)

      const btn = document.createElement('button')
      btn.className = u.is_blocked ? 'unblock-btn' : 'block-btn'
      btn.textContent = u.is_blocked ? 'Entsperren' : 'Sperren'
      btn.addEventListener('click', () => setBlocked(u, !u.is_blocked))
      row.appendChild(btn)

      list.appendChild(row)
    })

  if (list.children.length === 0) {
    list.textContent = 'Noch keine anderen Nutzer.'
  }
}

async function setGender(userId, gender) {
  const { error } = await supabaseClient
    .from('profiles')
    .update({ gender: gender || null })
    .eq('id', userId)

  if (error) alert('Fehler: ' + error.message)
  loadUsers()
}

async function setBlocked(user, blocked) {
  if (!isAdmin()) return
  const name = user.display_name || 'diesen Nutzer'
  const question = blocked ? name + ' sperren?' : name + ' wieder entsperren?'
  if (!confirm(question)) return

  const { data, error } = await supabaseClient
    .from('profiles')
    .update({ is_blocked: blocked })
    .eq('id', user.id)
    .select()

  if (error) {
    alert('Fehler: ' + error.message)
  } else if (!data || data.length === 0) {
    alert('Änderung nicht erlaubt.')
  }

  loadUsers()
}

// 11. Ausloggen
async function logout() {
  await supabaseClient.auth.signOut()
  showLogin()
}

// Enter-Taste
function onEnter(id, fn) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      fn()
    }
  })
}

onEnter('message-input', sendMessage)
onEnter('username', login)
onEnter('password', login)
onEnter('forgot-username', sendPasswordReset)
onEnter('reset-password', completePasswordReset)

init()