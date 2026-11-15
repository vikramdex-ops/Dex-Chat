// Organisation: departments, designations, reporting lines, contact details and custom
// profile fields. Profiles are keyed by Windows account, so an administrator can import the
// whole office from a spreadsheet before people have installed the app.
import type { DatabaseSync } from 'node:sqlite';
import { accountKey, ulid } from '@dex/core';
import type { Department, ImportResult, ImportRow, OrgInfo, Ops, ProfileField, PublicUser } from '@dex/core';
import type { Store } from './store.ts';

export class OrgError extends Error {}

interface DeptRow { id: string; name: string; parent_id: string | null; head_id: string | null; created_at: number }

const PROFILE_COLS = ['title', 'department_id', 'manager_account', 'phone', 'extension', 'location', 'email', 'employee_id', 'joined_on', 'birthday', 'fields', 'display_name'] as const;
type ProfileCol = typeof PROFILE_COLS[number];

const MAX_FIELDS = 12;
const MAX_DEPARTMENTS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIRTHDAY_RE = /^\d{2}-\d{2}$/;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return s || null;
};

function validDate(v: string | null, label: string): string | null {
  if (v === null) return null;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new OrgError(`${label} should look like 2024-06-30.`);
  return v;
}

function validBirthday(v: string | null): string | null {
  if (v === null) return null;
  const m = v.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!m) throw new OrgError('Birthday should look like 06-30 (month and day).');
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new OrgError('That birthday is not a real date.');
  const out = `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return BIRTHDAY_RE.test(out) ? out : null;
}

export class Org {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  /** Tell everyone a person's details changed. */
  private readonly userChanged: (u: PublicUser) => void;
  private readonly orgChanged: (o: OrgInfo) => void;

  constructor(store: Store, userChanged: Org['userChanged'], orgChanged: Org['orgChanged']) {
    this.store = store;
    this.db = store.db;
    this.userChanged = userChanged;
    this.orgChanged = orgChanged;
  }

  info(): OrgInfo {
    const departments = (this.db.prepare('SELECT * FROM departments ORDER BY name COLLATE NOCASE').all() as unknown as DeptRow[])
      .map((d): Department => ({ id: d.id, name: d.name, parentId: d.parent_id, headId: d.head_id, createdAt: d.created_at }));
    return { departments, fields: this.fields() };
  }

  private fields(): ProfileField[] {
    try {
      const raw = this.store.meta('profile_fields', () => '[]');
      const v = JSON.parse(raw) as ProfileField[];
      return Array.isArray(v) ? v.filter((f) => typeof f?.id === 'string' && typeof f?.label === 'string') : [];
    } catch { return []; }
  }

  /** Write profile columns for an account, creating the row if needed. */
  private writeProfile(account: string, patch: Partial<Record<ProfileCol, string | null>>): void {
    this.db.prepare('INSERT OR IGNORE INTO profiles (account) VALUES (?)').run(account);
    const cols = (Object.keys(patch) as ProfileCol[]).filter((c) => PROFILE_COLS.includes(c));
    if (!cols.length) return;
    this.db.prepare(`UPDATE profiles SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE account = ?`).run(...cols.map((c) => patch[c] ?? null), account);
  }

  private profileRow(account: string): Record<string, string | null> | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE account = ?').get(account) as Record<string, string | null> | undefined;
  }

  /** Their seat on the floor plan, when they have one (their location then comes from it). */
  private seatOf(account: string): string | null {
    return (this.db.prepare('SELECT seat_id FROM profiles WHERE account = ?').get(account) as { seat_id: string | null } | undefined)?.seat_id ?? null;
  }

  private department(id: unknown): DeptRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as DeptRow | undefined : undefined;
  }

  /** Would making `managerAccount` the manager of `account` create a loop? */
  private wouldLoop(account: string, managerAccount: string): boolean {
    let cur: string | null = managerAccount;
    for (let i = 0; cur && i < 500; i++) {
      if (cur === account) return true;
      const row = this.db.prepare('SELECT manager_account FROM profiles WHERE account = ?').get(cur) as { manager_account: string | null } | undefined;
      cur = row?.manager_account ?? null;
    }
    return false;
  }

  private announce(userId: string): void {
    const u = this.store.userById(userId);
    if (u) this.userChanged(u);
  }

  /** Everyone whose manager is this account (their managerId changes when it joins). */
  announceReportsOf(account: string): void {
    const rows = this.db.prepare('SELECT u.id FROM profiles p JOIN users u ON u.account = p.account WHERE p.manager_account = ?').all(account) as Array<{ id: string }>;
    for (const r of rows) this.announce(r.id);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    if (op.startsWith('admin.') && !isAdmin) throw new OrgError('Only administrators can do that.');

    switch (op) {
      case 'org.get':
        return this.info() satisfies Ops['org.get']['res'];

      case 'me.profile': {
        if (me.role === 'bot') throw new OrgError('Integrations have no profile.');
        const patch: Partial<Record<ProfileCol, string | null>> = {};
        if (d.phone !== undefined) patch.phone = clean(d.phone, 40);
        if (d.extension !== undefined) patch.extension = clean(d.extension, 12);
        if (d.location !== undefined && clean(d.location, 80) !== (this.profileRow(me.account)?.location ?? null)) {
          if (this.seatOf(me.account)) throw new OrgError('Your seat comes from the floor plan. Ask the office manager to move you.');
          patch.location = clean(d.location, 80);
        }
        if (d.birthday !== undefined) patch.birthday = validBirthday(clean(d.birthday, 5));
        this.writeProfile(me.account, patch);
        this.announce(me.id);
        return this.store.userById(me.id)!;
      }

      case 'admin.org.saveDepartment': {
        const name = clean(d.name, 60);
        if (!name) throw new OrgError('Give the department a name.');
        const existing = this.department(d.id);
        if (d.id !== undefined && !existing) throw new OrgError('Department not found.');
        const clash = this.db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
        if (clash && clash.id !== existing?.id) throw new OrgError('A department with that name already exists.');
        let parentId = d.parentId === undefined ? (existing?.parent_id ?? null) : (typeof d.parentId === 'string' ? d.parentId : null);
        if (parentId) {
          if (!this.department(parentId)) throw new OrgError('The parent department was not found.');
          // a department cannot sit under itself or its own sub-departments
          for (let cur: string | null = parentId, i = 0; cur && i < 500; i++) {
            if (cur === existing?.id) throw new OrgError('A department cannot sit under one of its own sub-departments.');
            cur = this.department(cur)?.parent_id ?? null;
          }
        } else parentId = null;
        let headId = d.headId === undefined ? (existing?.head_id ?? null) : (typeof d.headId === 'string' ? d.headId : null);
        if (headId && !this.store.userById(headId)) headId = null;
        if (existing) {
          this.db.prepare('UPDATE departments SET name = ?, parent_id = ?, head_id = ? WHERE id = ?').run(name, parentId, headId, existing.id);
        } else {
          const n = (this.db.prepare('SELECT COUNT(*) AS n FROM departments').get() as { n: number }).n;
          if (n >= MAX_DEPARTMENTS) throw new OrgError('There are already 200 departments.');
          this.db.prepare('INSERT INTO departments (id, name, parent_id, head_id, created_at) VALUES (?, ?, ?, ?, ?)').run(ulid(), name, parentId, headId, Date.now());
        }
        this.store.audit(me.id, existing ? 'org.department.update' : 'org.department.create', null, { name });
        const info = this.info();
        this.orgChanged(info);
        return info.departments.find((x) => x.name.toLowerCase() === name.toLowerCase())!;
      }

      case 'admin.org.deleteDepartment': {
        const dep = this.department(d.id);
        if (!dep) throw new OrgError('Department not found.');
        const people = this.db.prepare('SELECT u.id FROM profiles p JOIN users u ON u.account = p.account WHERE p.department_id = ?').all(dep.id) as Array<{ id: string }>;
        this.db.prepare('UPDATE profiles SET department_id = NULL WHERE department_id = ?').run(dep.id);
        this.db.prepare('UPDATE departments SET parent_id = ? WHERE parent_id = ?').run(dep.parent_id, dep.id);
        this.db.prepare('DELETE FROM departments WHERE id = ?').run(dep.id);
        this.store.audit(me.id, 'org.department.delete', null, { name: dep.name });
        this.orgChanged(this.info());
        for (const p of people) this.announce(p.id);
        return { ok: true } satisfies Ops['admin.org.deleteDepartment']['res'];
      }

      case 'admin.org.saveFields': {
        const list = Array.isArray(d.fields) ? d.fields : [];
        if (list.length > MAX_FIELDS) throw new OrgError(`Up to ${MAX_FIELDS} custom fields.`);
        const fields: ProfileField[] = [];
        for (const f of list as Array<Record<string, unknown>>) {
          const label = clean(f?.label, 40);
          if (!label) continue;
          if (fields.some((x) => x.label.toLowerCase() === label.toLowerCase())) throw new OrgError(`"${label}" appears twice.`);
          fields.push({ id: typeof f.id === 'string' && /^[a-z0-9]{4,32}$/i.test(f.id) ? f.id : ulid().slice(-10).toLowerCase(), label });
        }
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('profile_fields', JSON.stringify(fields));
        this.store.audit(me.id, 'org.fields', null, { labels: fields.map((f) => f.label) });
        this.orgChanged(this.info());
        return fields satisfies Ops['admin.org.saveFields']['res'];
      }

      case 'admin.org.setProfile': {
        const target = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!target || target.role === 'bot') throw new OrgError('Person not found.');
        const patch: Partial<Record<ProfileCol, string | null>> = {};
        const text: Array<[keyof typeof d, ProfileCol, number]> = [['phone', 'phone', 40], ['extension', 'extension', 12], ['location', 'location', 80], ['email', 'email', 120], ['employeeId', 'employee_id', 40]];
        for (const [k, col, max] of text) if (d[k] !== undefined) patch[col] = clean(d[k], max);
        // a seat on the floor plan sets the location; the free text is only for offices with no plan
        if (patch.location !== undefined && this.seatOf(target.account)) {
          if (patch.location !== (this.profileRow(target.account)?.location ?? null)) throw new OrgError(`${target.displayName}'s seat comes from the floor plan. Move them on the Floor sheet.`);
          delete patch.location;
        }
        if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) throw new OrgError('That email address does not look right.');
        if (d.joinedOn !== undefined) patch.joined_on = validDate(clean(d.joinedOn, 10), 'Joining date');
        if (d.birthday !== undefined) patch.birthday = validBirthday(clean(d.birthday, 5));
        if (d.departmentId !== undefined) {
          if (d.departmentId !== null && !this.department(d.departmentId)) throw new OrgError('Department not found.');
          patch.department_id = (d.departmentId as string | null) ?? null;
        }
        if (d.managerId !== undefined) {
          if (d.managerId === null) patch.manager_account = null;
          else {
            const mgr = typeof d.managerId === 'string' ? this.store.userById(d.managerId) : null;
            if (!mgr || mgr.role === 'bot') throw new OrgError('Manager not found.');
            if (this.wouldLoop(target.account, mgr.account)) throw new OrgError(`${mgr.displayName} already reports to ${target.displayName}, directly or through others.`);
            patch.manager_account = mgr.account;
          }
        }
        if (d.fields !== undefined) {
          const defs = new Set(this.fields().map((f) => f.id));
          const out: Record<string, string> = {};
          if (d.fields && typeof d.fields === 'object') for (const [k, v] of Object.entries(d.fields as Record<string, unknown>)) { const c = clean(v, 200); if (defs.has(k) && c) out[k] = c; }
          patch.fields = JSON.stringify(out);
        }
        this.writeProfile(target.account, patch);
        if (d.title !== undefined) this.store.updateUser(target.id, { title: clean(d.title, 80) });
        this.store.audit(me.id, 'org.profile', target.id, { changed: Object.keys(d).filter((k) => k !== 'userId') });
        this.announce(target.id);
        return this.store.userById(target.id)!;
      }

      case 'admin.org.import':
        return this.importRows(me, Array.isArray(d.rows) ? d.rows as ImportRow[] : [], d.dryRun === true) satisfies ImportResult;
    }
    return undefined;
  }

  /** Bulk import from a spreadsheet, matched by Windows account (DOMAIN\\user or just user). */
  private importRows(me: PublicUser, rows: ImportRow[], dryRun: boolean): ImportResult {
    const result: ImportResult = { updated: 0, waiting: 0, departmentsCreated: 0, problems: [] };
    if (rows.length > 2000) throw new OrgError('Import up to 2,000 people at a time.');
    const defaultDomain = me.account.includes('\\') ? me.account.split('\\')[0] : '';
    const resolve = (raw: unknown): string | null => {
      const v = clean(raw, 120);
      if (!v) return null;
      if (v.includes('\\')) { const [domain, user] = v.split('\\'); return accountKey({ domain, username: user }); }
      const existing = this.store.userForAccount(v);
      return existing ? existing.account : accountKey({ domain: defaultDomain, username: v });
    };
    const deptIds = new Map((this.db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>).map((x) => [x.name.toLowerCase(), x.id] as const));
    const fieldDefs = this.fields();
    const byLabel = new Map(fieldDefs.map((f) => [f.label.toLowerCase(), f.id] as const));
    const pendingManagers: Array<{ row: number; account: string; manager: string }> = [];
    const work = () => {
      rows.forEach((r, i) => {
        const line = i + 2; // header is line 1 in a spreadsheet
        try {
          const account = resolve(r?.account);
          if (!account) throw new OrgError('No Windows account.');
          const patch: Partial<Record<ProfileCol, string | null>> = {};
          const set = (col: ProfileCol, v: unknown, max: number) => { const c = clean(v, max); if (c !== null) patch[col] = c; };
          set('display_name', r.displayName, 80);
          set('title', r.title, 80);
          set('phone', r.phone, 40);
          set('extension', r.extension, 12);
          if (!this.seatOf(account)) set('location', r.location, 80);
          set('email', r.email, 120);
          set('employee_id', r.employeeId, 40);
          if (clean(r.joinedOn, 10)) patch.joined_on = validDate(clean(r.joinedOn, 10), 'Joining date');
          if (clean(r.birthday, 5)) patch.birthday = validBirthday(clean(r.birthday, 5));
          const deptName = clean(r.department, 60);
          if (deptName) {
            let id = deptIds.get(deptName.toLowerCase());
            if (!id) {
              id = ulid();
              this.db.prepare('INSERT INTO departments (id, name, parent_id, head_id, created_at) VALUES (?, ?, NULL, NULL, ?)').run(id, deptName, Date.now());
              deptIds.set(deptName.toLowerCase(), id);
              result.departmentsCreated++;
            }
            patch.department_id = id;
          }
          if (r.fields && typeof r.fields === 'object') {
            const cur = parseObj(this.profileRow(account)?.fields ?? null);
            for (const [label, v] of Object.entries(r.fields)) {
              const id = byLabel.get(label.toLowerCase()) ?? (fieldDefs.some((f) => f.id === label) ? label : null);
              const c = clean(v, 200);
              if (id && c) cur[id] = c;
            }
            patch.fields = JSON.stringify(cur);
          }
          this.writeProfile(account, patch);
          const user = this.store.userByAccount(account);
          if (user) {
            const p: { displayName?: string; title?: string | null } = {};
            if (patch.display_name) p.displayName = patch.display_name;
            if (patch.title) p.title = patch.title;
            if (Object.keys(p).length) this.store.updateUser(user.id, p);
            result.updated++;
          } else result.waiting++;
          const mgr = clean(r.manager, 120);
          if (mgr) pendingManagers.push({ row: line, account, manager: mgr });
        } catch (err) {
          result.problems.push({ row: line, message: err instanceof OrgError ? err.message : 'This row could not be read.' });
        }
      });
      // managers after everyone exists, so order in the sheet does not matter
      for (const p of pendingManagers) {
        const mgrAccount = resolve(p.manager);
        if (!mgrAccount || mgrAccount === p.account) { result.problems.push({ row: p.row, message: 'Someone cannot report to themselves.' }); continue; }
        if (this.wouldLoop(p.account, mgrAccount)) { result.problems.push({ row: p.row, message: `Reporting line to ${p.manager} would go round in a circle.` }); continue; }
        this.writeProfile(p.account, { manager_account: mgrAccount });
      }
    };
    // a dry run checks everything, then rolls back
    this.db.exec('BEGIN');
    try {
      work();
      if (dryRun) this.db.exec('ROLLBACK'); else this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (!dryRun) {
      this.store.audit(me.id, 'org.import', null, { updated: result.updated, waiting: result.waiting, problems: result.problems.length });
      this.orgChanged(this.info());
      for (const u of this.store.activeUsers()) if (u.role !== 'bot') this.userChanged(u);
    }
    return result;
  }
}

function parseObj(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try { const v = JSON.parse(raw) as Record<string, string>; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
