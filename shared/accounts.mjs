import fs from 'node:fs';
import { studioThemes, studioPatterns } from './appearance.mjs';
import path from 'node:path';
import crypto from 'node:crypto';

export function accountStore(dir, owner) {
  const file = path.join(dir, 'accounts.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { users: {}, rooms: {}, invites: {} };
    if (owner) {
      data.users[owner] = { username: owner, personalRoom: 'personal', preferences: {} };
      data.rooms.personal = { id: 'personal', name: 'Personal', owner, private: true, members: [owner] };
    }
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  if (owner && !fs.existsSync(file)) save();
  data.emailLinks ||= {};
  data.emailRequests ||= {};
  const emailHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const cleanEmail = (value) => {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) throw new Error('Enter a valid email address.');
    return email;
  };
  const cleanName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 ? value.trim() : null;
  function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  }
  function validInvite(token) {
    const invite = data.invites[token];
    return invite && invite.expires > Date.now() && data.rooms[invite.room] ? invite : null;
  }
  data.emailGrants ||= {};
  data.shortcuts ||= {}; // capture token → { user, created }: one per user, for the Siri shortcuts
  data.bots ||= {};
  function pruneEmail() {
    for (const [id, link] of Object.entries(data.emailLinks)) if (link.expires <= Date.now()) delete data.emailLinks[id];
    for (const [id, sent] of Object.entries(data.emailRequests)) if (sent <= Date.now() - 60000) delete data.emailRequests[id];
    for (const [id, grant] of Object.entries(data.emailGrants)) if (grant.expires <= Date.now()) delete data.emailGrants[id];
  }
  function findLink(token) {
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const link = data.emailLinks[emailHash(token)];
    if (!link || link.expires <= Date.now()) return null;
    return { ...link, key: emailHash(token) };
  }
  /** Find or create the account a verified link belongs to, join its room, and spend the link. */
  function resolveLink(link) {
    if (link.invite && !validInvite(link.invite)) throw new Error('The room invitation has expired or has already been used.');
    const existing = Object.values(data.users).find((user) => user.email === link.email);
    if (link.username && existing && existing.username !== link.username) throw new Error('This email already belongs to another account.');
    let user = (Object.hasOwn(data.users, link.username) ? data.users[link.username] : null) || existing;
    if (!user) {
      const id = crypto.randomUUID();
      const username = Object.hasOwn(data.users, link.email) ? `${link.email}#${id}` : link.email;
      user = { username, email: link.email, personalRoom: id, preferences: {}, sessionKey: crypto.randomBytes(32).toString('hex') };
      data.users[user.username] = user;
      data.rooms[id] = { id, name: 'Personal', owner: user.username, private: true, members: [user.username] };
    }
    user.email = link.email;
    delete data.emailLinks[link.key];
    // Older links must not change a verified address back after a later confirmation.
    for (const [id, other] of Object.entries(data.emailLinks)) if (other.username === user.username || other.email === user.email) delete data.emailLinks[id];
    const room = link.invite ? joinRoom(user.username, link.invite) : data.rooms[user.personalRoom] || null;
    return { user, room };
  }
  function joinRoom(username, token) {
    const invite = validInvite(token);
    if (!invite) throw new Error('This invitation has expired or has already been used.');
    const room = data.rooms[invite.room];
    if (!room.members.includes(username)) room.members.push(username);
    delete data.invites[token];
    return room;
  }
  return {
    user: (username) => Object.hasOwn(data.users, username) ? data.users[username] : null,
    rooms: (username) => Object.values(data.rooms).filter((room) => room.members.includes(username)).sort((a, b) => Number(b.private) - Number(a.private) || a.name.localeCompare(b.name)),
    allRooms: () => Object.values(data.rooms),
    room: (id) => Object.hasOwn(data.rooms, id) ? data.rooms[id] : null,
    bot: (name) => data.bots[name] || null,
    botForToken(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const digest = emailHash(token);
      for (const [name, bot] of Object.entries(data.bots)) {
        if (typeof bot.tokenHash === 'string' && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(bot.tokenHash))) return { name, ...bot };
      }
      return null;
    },
    ensureBot(ownerName, name) {
      if (!['sherlock', 'claw', 'lurch'].includes(name) || !this.user(ownerName)) throw new Error('Unknown bot or owner.');
      const existing = data.bots[name];
      if (existing) return { name, ...existing, token: null };
      const roomId = crypto.randomUUID(), username = `bot:${name}`;
      const token = crypto.randomBytes(32).toString('hex');
      data.users[username] = { username, personalRoom: roomId, preferences: {}, bot: name };
      data.rooms[roomId] = { id: roomId, name: name[0].toUpperCase() + name.slice(1), owner: ownerName, private: false, bot: name, members: [ownerName, username] };
      data.bots[name] = { username, room: roomId, tokenHash: emailHash(token) };
      save();
      return { name, ...data.bots[name], token };
    },
    verify(username, password) {
      const saved = this.user(username)?.password;
      if (!saved || typeof password !== 'string' || password.length > 1024) return false;
      const actual = hash(password, saved.split(':')[0]);
      return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(saved));
    },
    createRoom(username, name) {
      name = cleanName(name);
      if (!name) throw new Error('Use a room name of 1–60 characters.');
      if (this.rooms(username).length >= 50) throw new Error('You can have up to 50 rooms.');
      const id = crypto.randomUUID();
      data.rooms[id] = { id, name, owner: username, private: false, members: [username] };
      save();
      return data.rooms[id];
    },
    invite(username, roomId, replace) {
      const room = this.room(roomId);
      if (!room || room.owner !== username || room.private || room.bot) throw new Error('Only the owner of a shared room can invite people.');
      for (const [token, invite] of Object.entries(data.invites)) if (invite.expires <= Date.now()) delete data.invites[token];
      // "New link" retires the link it replaces (only one of this room's).
      if (typeof replace === 'string' && Object.hasOwn(data.invites, replace) && data.invites[replace].room === roomId) delete data.invites[replace];
      const token = crypto.randomBytes(32).toString('base64url');
      data.invites[token] = { room: roomId, expires: Date.now() + 7 * 86400000 };
      save();
      return token;
    },
    inviteExpires: (token) => (Object.hasOwn(data.invites, token) ? data.invites[token].expires : null),
    renameRoom(username, roomId, name) {
      const room = this.room(roomId);
      if (!room || room.owner !== username || room.private || room.bot) throw new Error('Only the owner of a shared room can rename it.');
      name = cleanName(name);
      if (!name) throw new Error('Use a room name of 1–60 characters.');
      room.name = name;
      save();
      return room;
    },
    leaveRoom(username, roomId) {
      const room = this.room(roomId);
      if (!room || room.private || room.bot || !room.members.includes(username)) throw new Error('You are not in this room.');
      if (room.owner === username) throw new Error('As the owner, delete the room instead.');
      room.members = room.members.filter((member) => member !== username);
      save();
    },
    /** Removes the room and its open invitations for everyone; its board files stay on disk. */
    deleteRoom(username, roomId) {
      const room = this.room(roomId);
      if (!room || room.owner !== username || room.private || room.bot) throw new Error('Only the owner of a shared room can delete it.');
      delete data.rooms[roomId];
      for (const [token, invite] of Object.entries(data.invites)) if (invite.room === roomId) delete data.invites[token];
      save();
    },
    inviteInfo(token) {
      const invite = validInvite(token);
      return invite ? { room: data.rooms[invite.room].name } : null;
    },
    join(username, token) {
      const room = joinRoom(username, token);
      save();
      return room;
    },
    register(username, password, token) {
      if (!validInvite(token)) throw new Error('This invitation has expired or has already been used.');
      if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username)) throw new Error('Use 3–40 letters, numbers, dots, dashes or underscores for your username.');
      if (this.user(username)) throw new Error('That username is already taken.');
      if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw new Error('Use a password of at least 10 characters.');
      const id = crypto.randomUUID();
      data.users[username] = { username, password: hash(password), personalRoom: id, preferences: {} };
      data.rooms[id] = { id, name: 'Personal', owner: username, private: true, members: [username] };
      return { user: data.users[username], room: this.join(username, token) };
    },
    requestEmail(value, { username, invite, device } = {}) {
      const email = cleanEmail(value);
      const existing = Object.values(data.users).find((user) => user.email === email);
      if (username && (!this.user(username) || (existing && existing.username !== username))) return null;
      if (invite && !validInvite(invite)) throw new Error('This invitation has expired or has already been used.');
      const key = emailHash(email);
      pruneEmail();
      // The device that asked keeps `request` (a secret) and shows `code`; approving the link means typing that code.
      const request = crypto.randomBytes(32).toString('base64url');
      const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      if (data.emailRequests[key] > Date.now() - 60000) {
        // Throttled: the reply looks the same from outside, and the device waits until the window ends.
        data.emailGrants[emailHash(request)] = { pending: true, expires: Date.now() + 15 * 60000 };
        save();
        return { email, token: null, request, code };
      }
      data.emailRequests[key] = Date.now();
      const token = crypto.randomBytes(32).toString('base64url');
      data.emailLinks[emailHash(token)] = { email, emailKey: key, username: username || existing?.username, invite, sent: Date.now(), expires: Date.now() + 15 * 60000, requestKey: emailHash(request), code, attempts: 0, device: typeof device === 'string' ? device.slice(0, 60) : '' };
      save();
      return { email, token, request, code };
    },
    cancelEmail(token) { delete data.emailLinks[emailHash(token)]; save(); },
    /** What the link page may show before anything is decided: which device asked, and its match code. */
    linkInfo(token) {
      const link = findLink(token);
      return link ? { device: link.device, sent: link.sent } : null;
    },
    /** Sign in the browser that opened the link. The device that asked (if another) learns the link was used. */
    consumeEmail(token) {
      const link = findLink(token);
      if (!link) throw new Error('This link has expired or has already been used. Request a new one.');
      const result = resolveLink(link);
      data.emailGrants[link.requestKey] = { used: true, expires: link.expires };
      save();
      return result;
    },
    /** Approve the sign-in for the device that asked, proven by typing the code it shows; the opening browser stays as it is. */
    approveEmail(token, code) {
      const link = findLink(token);
      if (!link) throw new Error('This link has expired or has already been used. Request a new one.');
      const typed = typeof code === 'string' ? code.replace(/\D/g, '') : '';
      if (typed.length !== 4 || !crypto.timingSafeEqual(Buffer.from(typed), Buffer.from(link.code))) {
        if (++data.emailLinks[link.key].attempts >= 5) delete data.emailLinks[link.key];
        save();
        throw new Error(data.emailLinks[link.key] ? "That code doesn't match the device that asked." : 'Too many wrong codes. Request a new link.');
      }
      const { user, room } = resolveLink(link);
      data.emailGrants[link.requestKey] = { user: user.username, room: room.id, expires: link.expires };
      save();
      return { user, room, device: link.device };
    },
    /** Polled by the device that asked. An approved session is handed over exactly once. */
    waitEmail(request) {
      if (typeof request !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(request)) return { status: 'expired' };
      pruneEmail();
      const key = emailHash(request);
      const grant = data.emailGrants[key];
      if (grant?.used) return { status: 'used' };
      if (grant?.pending) return { status: 'pending' };
      if (grant) {
        delete data.emailGrants[key];
        save();
        return { status: 'approved', user: grant.user, room: grant.room };
      }
      return Object.values(data.emailLinks).some((link) => link.requestKey === key) ? { status: 'pending' } : { status: 'expired' };
    },
    /** The Siri shortcuts' token for this user (plain, so the shortcut files can embed it), or null. */
    shortcutToken(username) {
      return Object.entries(data.shortcuts).find(([, s]) => s.user === username)?.[0] ?? null;
    },
    shortcutState(username) {
      const entry = Object.entries(data.shortcuts).find(([, s]) => s.user === username);
      return entry ? { enabled: true, created: entry[1].created } : { enabled: false, created: null };
    },
    /** A new token replaces the old one: shortcuts installed before stop working. */
    createShortcutToken(username) {
      if (!this.user(username)) throw new Error('Account not found.');
      for (const [token, s] of Object.entries(data.shortcuts)) if (s.user === username) delete data.shortcuts[token];
      const token = crypto.randomBytes(32).toString('base64url');
      data.shortcuts[token] = { user: username, created: Date.now() };
      save();
      return token;
    },
    revokeShortcutToken(username) {
      for (const [token, s] of Object.entries(data.shortcuts)) if (s.user === username) delete data.shortcuts[token];
      save();
    },
    /** Which user a capture token belongs to, or null. Constant time per stored token. */
    shortcutUser(token) {
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
      let found = null;
      for (const [stored, s] of Object.entries(data.shortcuts)) if (crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(token)) && this.user(s.user)) found = s.user;
      return found;
    },
    preferences(username, input) {
      const user = this.user(username);
      if (!user) throw new Error('Account not found.');
      const preferences = {};
      if (studioThemes.some(t => t.id === input?.studioTheme)) preferences.studioTheme = input.studioTheme;
      if (studioPatterns.some(p => p.id === input?.studioPattern)) preferences.studioPattern = input.studioPattern;
      if (['system', 'light', 'dark', 'sky'].includes(input?.theme)) preferences.theme = input.theme;
      if (['system', 'on', 'off'].includes(input?.reduceMotion)) preferences.reduceMotion = input.reduceMotion;
      if (typeof input?.suggest === 'boolean') preferences.suggest = input.suggest;
      user.preferences = { ...user.preferences, ...preferences };
      save();
      return user.preferences;
    },
  };
}
