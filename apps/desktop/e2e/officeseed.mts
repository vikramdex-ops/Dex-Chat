// Seeds a realistic Dexterity Design Services office into a running e2e hub: departments,
// designations, line managers, seats, extensions, joined dates and birthdays. Seeded people get
// an approved device so colleagues can see them; some connect for real to be online.
import crypto from 'node:crypto';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';

type P = { u: string; name: string; title: string; dept: string; mgr?: string; seat?: string; ext?: string; joined?: string; bday?: string };

const today = new Date();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86400_000));
const mmdd = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// a work anniversary today: joined on today's date some years back
const yearsAgoToday = (y: number) => `${today.getFullYear() - y}-${mmdd(today)}`;

export const OFFICE: P[] = [
  { u: 'vikram', name: 'Vikram Shah', title: 'Managing Director', dept: 'Management', seat: 'Cabin 1', ext: '201', joined: '2009-06-01', bday: '03-14' },
  { u: 'meera', name: 'Meera Nair', title: 'Director, Engineering', dept: 'Management', mgr: 'vikram', seat: 'Cabin 2', ext: '202', joined: '2011-02-14', bday: '07-22' },
  { u: 'arjun', name: 'Arjun Mehta', title: 'Director, Projects', dept: 'Management', mgr: 'vikram', seat: 'Cabin 3', ext: '203', joined: '2012-09-03', bday: '11-02' },
  { u: 'priya', name: 'Priya Raman', title: 'Lead Piping Designer', dept: 'Piping', mgr: 'meera', seat: 'Bay 2, Desk 1', ext: '214', joined: '2016-04-12', bday: '06-30' },
  { u: 'ravi', name: 'Ravi Kumar', title: 'Senior Piping Designer', dept: 'Piping', mgr: 'priya', seat: 'Bay 2, Desk 2', ext: '215', joined: '2018-01-08', bday: '01-19' },
  { u: 'karthik', name: 'Karthik Subramanian', title: 'Piping Designer', dept: 'Piping', mgr: 'priya', seat: 'Bay 2, Desk 3', ext: '216', joined: '2020-07-20', bday: mmdd(today) },
  { u: 'deepa', name: 'Deepa Krishnan', title: 'Stress Engineer', dept: 'Piping', mgr: 'priya', seat: 'Bay 2, Desk 4', ext: '217', joined: yearsAgoToday(5), bday: '09-09' },
  { u: 'rahul', name: 'Rahul Joshi', title: 'Graduate Piping Engineer', dept: 'Piping', mgr: 'ravi', seat: 'Bay 2, Desk 5', ext: '218', joined: daysAgo(6), bday: '04-04' },
  { u: 'lakshmi', name: 'Lakshmi Venkatesh', title: 'Piping Designer', dept: 'Piping', mgr: 'ravi', seat: 'Bay 2, Desk 6', ext: '219', joined: '2021-11-15', bday: '12-12' },
  { u: 'imran', name: 'Imran Shaikh', title: 'Piping Checker', dept: 'Piping', mgr: 'priya', seat: 'Site — Dahej', ext: '220', joined: '2014-03-10', bday: '05-27' },
  { u: 'anand', name: 'Anand Pillai', title: 'Structural Lead', dept: 'Structural', mgr: 'meera', seat: 'Bay 3, Desk 1', ext: '231', joined: '2013-05-06', bday: '02-11' },
  { u: 'sneha', name: 'Sneha Kulkarni', title: 'Structural Engineer', dept: 'Structural', mgr: 'anand', seat: 'Bay 3, Desk 2', ext: '232', joined: '2019-06-17', bday: '08-08' },
  { u: 'vivek', name: 'Vivek Reddy', title: 'Structural Engineer', dept: 'Structural', mgr: 'anand', seat: 'Bay 3, Desk 3', ext: '233', joined: '2022-02-01', bday: '10-30' },
  { u: 'pooja', name: 'Pooja Bhat', title: 'Steel Detailer', dept: 'Structural', mgr: 'anand', seat: 'Bay 3, Desk 4', ext: '234', joined: daysAgo(18), bday: '03-03' },
  { u: 'farhan', name: 'Farhan Qureshi', title: 'Steel Detailer', dept: 'Structural', mgr: 'sneha', seat: 'Bay 3, Desk 5', ext: '235', joined: '2023-08-21', bday: '06-06' },
  { u: 'anita', name: 'Anita Rao', title: 'Civil Lead', dept: 'Civil', mgr: 'meera', seat: 'Bay 4, Desk 1', ext: '301', joined: '2015-08-15', bday: '01-01' },
  { u: 'sanjay', name: 'Sanjay Iyer', title: 'Civil Draughtsman', dept: 'Civil', mgr: 'anita', seat: 'Bay 4, Desk 2', ext: '302', joined: '2022-10-10', bday: '07-07' },
  { u: 'kavya', name: 'Kavya Menon', title: 'Civil Engineer', dept: 'Civil', mgr: 'anita', seat: 'Bay 4, Desk 3', ext: '303', joined: '2020-01-13', bday: '09-21' },
  { u: 'suresh', name: 'Suresh Babu', title: 'Mechanical Lead', dept: 'Mechanical', mgr: 'meera', seat: 'Bay 5, Desk 1', ext: '311', joined: '2012-12-03', bday: '04-18' },
  { u: 'nikhil', name: 'Nikhil Gupta', title: 'Static Equipment Engineer', dept: 'Mechanical', mgr: 'suresh', seat: 'Bay 5, Desk 2', ext: '312', joined: '2019-09-02', bday: '11-11' },
  { u: 'divya', name: 'Divya Prakash', title: 'Rotating Equipment Engineer', dept: 'Mechanical', mgr: 'suresh', seat: 'Bay 5, Desk 3', ext: '313', joined: '2021-03-22', bday: '02-28' },
  { u: 'ramesh', name: 'Ramesh Chandran', title: 'E&I Lead', dept: 'Electrical & Instrumentation', mgr: 'meera', seat: 'Bay 5, Desk 5', ext: '321', joined: '2014-07-07', bday: '05-05' },
  { u: 'harini', name: 'Harini Sundaram', title: 'Instrument Engineer', dept: 'Electrical & Instrumentation', mgr: 'ramesh', seat: 'Bay 5, Desk 6', ext: '322', joined: '2020-11-30', bday: '08-19' },
  { u: 'gopal', name: 'Gopal Das', title: 'Electrical Designer', dept: 'Electrical & Instrumentation', mgr: 'ramesh', seat: 'Bay 5, Desk 7', ext: '323', joined: '2017-04-24', bday: '12-01' },
  { u: 'lalitha', name: 'Lalitha Murthy', title: 'CAD Manager', dept: 'Drafting', mgr: 'arjun', seat: 'Bay 1, Desk 1', ext: '241', joined: '2010-10-11', bday: '10-10' },
  { u: 'manoj', name: 'Manoj Patil', title: 'Senior Draughtsman', dept: 'Drafting', mgr: 'lalitha', seat: 'Bay 1, Desk 2', ext: '242', joined: '2013-01-21', bday: '06-15' },
  { u: 'asha', name: 'Asha Thomas', title: 'Draughtswoman', dept: 'Drafting', mgr: 'lalitha', seat: 'Bay 1, Desk 3', ext: '243', joined: '2018-05-14', bday: '03-29' },
  { u: 'prakash', name: 'Prakash Naidu', title: 'BIM Modeller', dept: 'Drafting', mgr: 'lalitha', seat: 'Bay 1, Desk 4', ext: '244', joined: '2021-07-05', bday: '09-01' },
  { u: 'selvi', name: 'Selvi Arumugam', title: 'Draughtswoman', dept: 'Drafting', mgr: 'manoj', seat: 'Bay 1, Desk 5', ext: '245', joined: '2023-02-27', bday: '01-26' },
  { u: 'kiran', name: 'Kiran Desai', title: 'CAD Technician', dept: 'Drafting', mgr: 'manoj', seat: 'Bay 1, Desk 6', ext: '246', joined: daysAgo(2), bday: '07-30' },
  { u: 'rohan', name: 'Rohan Kapoor', title: 'Project Manager', dept: 'Projects', mgr: 'arjun', seat: 'Bay 6, Desk 1', ext: '251', joined: '2015-03-02', bday: '05-12' },
  { u: 'neha', name: 'Neha Agarwal', title: 'Planning Engineer', dept: 'Projects', mgr: 'rohan', seat: 'Bay 6, Desk 2', ext: '252', joined: '2019-12-09', bday: '02-02' },
  { u: 'aditya', name: 'Aditya Rao', title: 'Project Engineer', dept: 'Projects', mgr: 'rohan', seat: 'Bay 6, Desk 3', ext: '253', joined: '2022-06-06', bday: '11-23' },
  { u: 'fatima', name: 'Fatima Begum', title: 'Document Controller', dept: 'Document Control', mgr: 'arjun', seat: 'Bay 6, Desk 5', ext: '261', joined: '2016-09-19', bday: '04-27' },
  { u: 'joseph', name: "Joseph D'Souza", title: 'Document Controller', dept: 'Document Control', mgr: 'fatima', seat: 'Bay 6, Desk 6', ext: '262', joined: '2024-01-15', bday: '12-25' },
  { u: 'sunil', name: 'Sunil Varghese', title: 'IT Manager', dept: 'IT & Admin', mgr: 'vikram', seat: 'Server room', ext: '271', joined: '2011-08-01', bday: '08-31' },
  { u: 'bhavna', name: 'Bhavna Shah', title: 'Office Administrator', dept: 'IT & Admin', mgr: 'sunil', seat: 'Front office', ext: '200', joined: '2017-02-06', bday: '03-08' },
  { u: 'revathi', name: 'Revathi Iyer', title: 'HR & Accounts Manager', dept: 'HR & Accounts', mgr: 'vikram', seat: 'Cabin 4', ext: '281', joined: '2012-04-16', bday: '10-05' },
  { u: 'ganesh', name: 'Ganesh Hegde', title: 'Accounts Executive', dept: 'HR & Accounts', mgr: 'revathi', seat: 'Front office', ext: '282', joined: '2020-08-24', bday: '06-21' },
  { u: 'thomas', name: 'Thomas Mathew', title: 'Site Engineer', dept: 'Piping', mgr: 'priya', seat: 'Site — Jamnagar', ext: '221', joined: '2019-02-18', bday: '07-14' },
];

const FIRST = ['Aarav', 'Aditi', 'Akash', 'Amala', 'Anil', 'Anjali', 'Arun', 'Bala', 'Chitra', 'Daniel', 'Dinesh', 'Esha', 'Gayatri', 'Hari', 'Indira', 'Jaya', 'Kamal', 'Kiran', 'Latha', 'Madhu', 'Mohan', 'Nandini', 'Naveen', 'Omkar', 'Padma', 'Raghav', 'Rekha', 'Sai', 'Sandhya', 'Shankar', 'Shruti', 'Siddharth', 'Tara', 'Uma', 'Varun', 'Vidya', 'Yash', 'Zoya'];
const LAST = ['Acharya', 'Bose', 'Chopra', 'Dutta', 'Fernandes', 'Ghosh', 'Hegde', 'Jain', 'Kamath', 'Lal', 'Mishra', 'Nambiar', 'Pandey', 'Rajan', 'Saxena', 'Sen', 'Tiwari', 'Upadhyay', 'Verma', 'Warrier', 'Yadav'];
const DEPTS: Array<{ dept: string; bay: number; titles: string[] }> = [
  { dept: 'Piping', bay: 2, titles: ['Piping Designer', 'Senior Piping Designer', 'Stress Engineer', 'Piping Checker'] },
  { dept: 'Structural', bay: 3, titles: ['Structural Engineer', 'Steel Detailer', 'Connection Designer'] },
  { dept: 'Civil', bay: 4, titles: ['Civil Engineer', 'Civil Draughtsman', 'Surveyor'] },
  { dept: 'Mechanical', bay: 5, titles: ['Static Equipment Engineer', 'Rotating Equipment Engineer'] },
  { dept: 'Electrical & Instrumentation', bay: 7, titles: ['Instrument Engineer', 'Electrical Designer', 'Control Systems Engineer'] },
  { dept: 'Drafting', bay: 1, titles: ['Draughtsman', 'CAD Technician', 'BIM Modeller'] },
  { dept: 'Projects', bay: 6, titles: ['Project Engineer', 'Planning Engineer', 'Cost Engineer'] },
  { dept: 'Document Control', bay: 8, titles: ['Document Controller'] },
];

/** A large office (n people) built on the in-depth one, with team leads and teams under each lead. */
export function bigOffice(n: number): P[] {
  const out = OFFICE.map((p) => ({ ...p }));
  const r = (() => { let s = 7; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const leads = new Map(DEPTS.map((d) => [d.dept, out.find((p) => p.dept === d.dept && (!p.mgr || !out.find((q) => q.u === p.mgr && q.dept === d.dept)))!.u] as const));
  const teamLeads: Record<string, string[]> = {};
  const desks: Record<number, number> = {};
  let i = 0;
  while (out.length < n) {
    const d = DEPTS[i % DEPTS.length];
    const tl = teamLeads[d.dept] ?? (teamLeads[d.dept] = []);
    const u = `x${i}`;
    const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
    const isLead = tl.length < 3 + (i % 3) && r() < 0.5;
    const mgr = isLead || !tl.length ? leads.get(d.dept)! : tl[Math.floor(r() * tl.length)];
    desks[d.bay] = (desks[d.bay] ?? 8) + 1;
    out.push({
      u, name, title: isLead ? `Team Lead, ${d.dept}` : d.titles[Math.floor(r() * d.titles.length)], dept: d.dept, mgr,
      seat: `Bay ${d.bay}, Desk ${desks[d.bay]}`, ext: String(400 + i),
      joined: `${2008 + Math.floor(r() * 18)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
      bday: `${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
    });
    if (isLead) tl.push(u);
    i++;
  }
  return out;
}

/**
 * Put the office into the hub. `hub` is the in-process Hub; `owner` (vikram) is an admin client.
 * Everyone except `skip` (who joins through the app) is created with an approved device.
 */
export async function seedOffice(hub: any, owner: any, people: P[], skip: string[] = ['vikram']) {
  const depts = new Map<string, string>();
  for (const name of [...new Set(people.map((p) => p.dept))]) depts.set(name, (await owner.request('admin.org.saveDepartment', { name })).id);
  const ids = new Map<string, string>();
  ids.set('vikram', owner.session.me.id);
  for (const p of people) {
    if (skip.includes(p.u)) continue;
    const key = `dex\\${p.u}`;
    const u = hub.store.userByAccount(key) ?? hub.store.createUser(key, p.name, 'member');
    hub.store.createDevice(crypto.randomUUID(), u.id, createIdentity().publicKey, `${p.u.toUpperCase()}-PC`, 'approved');
    ids.set(p.u, u.id);
  }
  return { depts, ids, async profiles(extra: Record<string, string> = {}) {
    for (const [u, id] of Object.entries(extra)) ids.set(u, id);
    for (const p of people) {
      const id = ids.get(p.u);
      if (!id) continue;
      await owner.request('admin.org.setProfile', {
        userId: id, title: p.title, departmentId: depts.get(p.dept), managerId: p.mgr ? ids.get(p.mgr) ?? null : null,
        location: p.seat ?? null, extension: p.ext ?? null, joinedOn: p.joined ?? null, birthday: p.bday ?? null,
      });
    }
    // department heads
    for (const [name, id] of depts) {
      const head = people.find((p) => p.dept === name && (!p.mgr || people.find((q) => q.u === p.mgr)?.dept !== name));
      if (head && ids.get(head.u)) await owner.request('admin.org.saveDepartment', { id, name, headId: ids.get(head.u) });
    }
  } };
}

/** Bring some seeded people online for real (their own client), optionally starting their day. */
export async function bringOnline(hubPort: number, fp: string, people: Array<{ u: string; name: string; mode?: string; status?: string }>) {
  const clients: any[] = [];
  for (const p of people) {
    const c = new HubClient({ identity: createIdentity(), account: { username: p.u, domain: 'DEX', displayName: p.name, hostname: `${p.u.toUpperCase()}-LAPTOP` } });
    c.connect({ host: '127.0.0.1', port: hubPort, fp });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${p.u} did not connect`)), 20000);
      const on = (s: { kind: string }) => { if (s.kind === 'ready') { clearTimeout(t); c.off('state', on); res(); } };
      c.on('state', on);
    });
    if (p.mode) await c.request('work.checkIn', { mode: p.mode }).catch(() => {});
    if (p.status) await c.request('me.update', { statusText: p.status }).catch(() => {});
    clients.push(c);
  }
  return clients;
}
