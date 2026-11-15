// Bot templates that carry a request through the office after it is sent: a second person acts on
// it (approves, checks, plots, issues, answers), the person who asked watches it move on the card
// they already have, reminders are few and polite, and one register card shows what is open.
// They are working bots as they stand; the bot maker's list (BOT_TEMPLATES in botmaker.ts) takes
// them from here. Every string a person reads is written to be translated whole (Hindi, Tamil).
import type { BotFlowDefinition, BotGlyph, BotPersona } from './bots.ts';

export interface OfficeTemplate { id: string; title: string; about: string; definition: BotFlowDefinition }

const persona = (glyph: BotGlyph, colour: BotPersona['colour'], about: string, tone: BotPersona['tone'] = 'plain', extra: Partial<BotPersona> = {}): BotPersona =>
  ({ mark: { kind: 'glyph', glyph }, colour, about, tone, remember: true, ...extra });

const WEEK = [1, 2, 3, 4, 5];
const WEEK6 = [1, 2, 3, 4, 5, 6];
const JOB = { type: 'regex' as const, pattern: '[A-Za-z]{1,4}-?\\d{3,6}', message: 'Write the job number: letters then digits, like P-12513.' };

// ---------------------------------------------------------------- plot request, with the plot queue
export const PLOT_REQUEST: OfficeTemplate = {
  id: 'plot-request', title: 'Plot request', about: 'Your lead approves, the plot room queues it, and you are told when it is ready to collect.',
  definition: {
    name: 'plot-request', title: 'Plot request', description: 'Ask for a plot set: your lead approves it, the plot room plots it, you collect it.',
    persona: persona('plotter', 'rust', 'Your lead approves, the plot room queues it, and you are told when it is ready to collect.', 'warm'),
    steps: [
      { id: 'job', label: 'Job', prompt: 'Which job is it for?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
      { id: 'drawings', label: 'Drawings', prompt: 'Which drawings, at which revision? One per line.', input: { kind: 'text', multiline: true, placeholder: 'ISO-1001-01 rev C' } },
      { id: 'size', label: 'Sheet size', prompt: 'Which sheet size?', input: { kind: 'choice', options: [{ value: 'A0', label: 'A0' }, { value: 'A1', label: 'A1' }, { value: 'A3', label: 'A3' }] } },
      { id: 'sets', label: 'Sets', prompt: 'How many sets?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 50 }, suggestions: ['1', '2', '3'] } },
      { id: 'due', label: 'Needed by', prompt: 'When do you need them?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      { id: 'lead', label: 'Approver', prompt: 'Who approves it? Usually your discipline lead.', input: { kind: 'person', suggest: 'lead' } },
      { id: 'ok', prompt: 'Send this to {{lead}}?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'job' }] },
    ],
    finish: [],
    done: 'Sent to {{lead}}. The plot room starts once it is approved.',
    track: {
      ref: 'PLT', name: '{{job}} · {{sets}} × {{size}}',
      roles: { plotroom: { label: 'Plot room' } },
      stages: [
        {
          id: 'approve', label: 'Approve', who: 'lead', due: 'due',
          prompt: '{{user}} asks for {{sets}} × {{size}} of {{job}}, needed by {{due}}.\n\n{{drawings}}',
          actions: [
            { id: 'ok', label: 'Approve', to: 'queue', tone: 'go' },
            { id: 'change', label: 'Ask for a change', to: 'change', note: 'required', ask: 'What to change', tone: 'back' },
            { id: 'no', label: 'Turn down', to: 'end', stamp: 'TURNED DOWN', outcome: 'stopped', note: 'required', ask: 'Reason', tone: 'stop' },
          ],
        },
        {
          id: 'change', label: 'Change', who: 'requester',
          prompt: '{{lead}} asks for a change before approving:\n\n{{note}}',
          actions: [{ id: 'again', label: 'Changed, send again', to: 'approve', note: 'required', ask: 'What changed', tone: 'go' }],
        },
        {
          id: 'queue', label: 'Plot queue', who: 'role:plotroom', due: 'due',
          prompt: 'Approved by {{lead}}: {{sets}} × {{size}} of {{job}} for {{user}}, needed by {{due}}.\n\n{{drawings}}',
          actions: [
            { id: 'start', label: 'Start plotting', to: 'plotting', tone: 'go' },
            { id: 'cannot', label: 'Cannot plot it', to: 'end', stamp: 'NOT PLOTTED', outcome: 'stopped', note: 'required', ask: 'Why', tone: 'stop' },
          ],
        },
        {
          id: 'plotting', label: 'Plotting', who: 'role:plotroom',
          prompt: 'Plotting {{sets}} × {{size}} of {{job}} for {{user}}.',
          actions: [{ id: 'ready', label: 'Ready to collect', to: 'collect', note: 'optional', ask: 'Where to collect them', tone: 'go' }],
        },
        {
          id: 'collect', label: 'Collect', who: 'requester', dueInDays: 1,
          prompt: 'Your plots of {{job}} are ready to collect. {{note}}',
          actions: [{ id: 'got', label: 'Collected', to: 'end', stamp: 'COLLECTED', tone: 'go' }],
        },
      ],
      remind: { afterHours: 4, times: 2, escalate: 'lead' },
      register: { to: 'role:plotroom', at: '09:15', days: WEEK6, columns: ['job', 'size', 'sets', 'due'] },
    },
  },
};

// ---------------------------------------------------------------- site visit, the whole loop
export const SITE_VISIT: OfficeTemplate = {
  id: 'site-visit', title: 'Site visit', about: 'Approval, gate pass, a safety checklist before you go, and the visit report after.',
  definition: {
    name: 'site-visit', title: 'Site visit', description: 'Plan a site visit: approval, gate pass, safety checklist and the visit report.',
    persona: persona('helmet', 'olive', 'Approval, gate pass, a safety checklist before you go, and the visit report after.', 'plain', { hours: { days: WEEK6, from: '09:00', to: '18:30' } }),
    steps: [
      { id: 'site', label: 'Site', prompt: 'Which site?', input: { kind: 'choice', options: [{ value: 'refinery', label: 'Refinery' }, { value: 'pump-house', label: 'Pump house' }, { value: 'depot', label: 'Depot' }, { value: 'client-office', label: 'Client office' }] } },
      { id: 'day', label: 'Day', prompt: 'Which day?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      { id: 'job', label: 'Job', prompt: 'Which job is it for?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
      { id: 'people', label: 'People', prompt: 'How many people are going?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 12 }, suggestions: ['1', '2', '4'] } },
      { id: 'purpose', label: 'Purpose', prompt: 'What is the visit for?', input: { kind: 'text', placeholder: 'Walk-down of the pipe rack' } },
      { id: 'contact', label: 'Site contact', prompt: 'Who is the contact on site? A name and a phone number.', input: { kind: 'text', placeholder: 'Mr Rao, 98400 12345' } },
      { id: 'ok', prompt: 'Send this to your lead for approval?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'site' }] },
    ],
    finish: [],
    done: 'Sent to your lead. Admin arranges the gate pass once it is approved, and your safety checklist comes before the day.',
    track: {
      ref: 'SV', name: '{{site}} · {{day}}',
      roles: { admin: { label: 'Admin and travel' } },
      stages: [
        {
          id: 'approve', label: 'Approve', who: 'lead', due: 'day',
          prompt: '{{user}} plans a visit to {{site}} on {{day}} for {{job}}, {{people}} going: {{purpose}}',
          actions: [
            { id: 'ok', label: 'Approve the visit', to: 'arrange', tone: 'go' },
            { id: 'no', label: 'Not now', to: 'end', stamp: 'NOT APPROVED', outcome: 'stopped', note: 'required', ask: 'Reason', tone: 'stop' },
          ],
        },
        {
          id: 'arrange', label: 'Gate pass', who: 'role:admin', due: 'day',
          prompt: 'Arrange the gate pass and travel for {{people}} to {{site}} on {{day}} ({{user}}, {{job}}). Site contact: {{contact}}.',
          actions: [{ id: 'done', label: 'Gate pass and travel arranged', to: 'prepare', note: 'optional', ask: 'For the team: vehicle, time, pass numbers', tone: 'go' }],
        },
        {
          id: 'prepare', label: 'Safety', who: 'requester', due: 'day',
          prompt: 'Before you go to {{site}} on {{day}}, tick each line. From admin: {{note}}',
          checklist: ['Safety shoes and helmet', 'High-visibility vest and safety glasses', 'Gate pass or permit to work', 'Company ID card', 'Latest drawings, printed or on the tablet', 'Site emergency contact and first aid point'],
          actions: [{ id: 'go', label: 'Ready to go', to: 'report', needsChecks: true, tone: 'go' }],
        },
        {
          id: 'report', label: 'Visit report', who: 'requester', dueInDays: 2, task: true,
          prompt: 'How was the visit to {{site}}? Write what you saw, what was agreed and the actions, with who does each.',
          actions: [{ id: 'send', label: 'Send the visit report', to: 'read', note: 'required', ask: 'Visit report', tone: 'go' }],
        },
        {
          id: 'read', label: 'Read', who: 'lead',
          prompt: 'Visit report from {{user}}, {{site}} on {{day}}:\n\n{{note}}',
          actions: [
            { id: 'ok', label: 'Noted', to: 'end', stamp: 'REPORTED', tone: 'go' },
            { id: 'more', label: 'Ask for more', to: 'report', note: 'required', ask: 'What else you need', tone: 'back' },
          ],
        },
      ],
      remind: { afterHours: 24, times: 2, escalate: 'lead' },
      register: { to: 'role:admin', at: '09:05', days: WEEK6, columns: ['site', 'day', 'people'] },
    },
  },
};

// ---------------------------------------------------------------- technical queries, to closeout
export const TECHNICAL_QUERY: OfficeTemplate = {
  id: 'rfi-log', title: 'Technical query (TQ)', about: 'Raise a TQ or RFI; your lead reviews it, the client’s reply is recorded, you close it out.',
  definition: {
    name: 'rfi-log', title: 'Technical query', description: 'Raise a TQ or RFI against a drawing, track the client’s reply and close it out.',
    persona: persona('rfi', 'indigo', 'Raise a TQ or RFI; your lead reviews it, the client’s reply is recorded, you close it out.', 'formal'),
    steps: [
      { id: 'job', label: 'Job', prompt: 'Which job?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
      { id: 'discipline', label: 'Discipline', prompt: 'Which discipline?', input: { kind: 'choice', options: [{ value: 'piping', label: 'Piping' }, { value: 'structural', label: 'Structural' }, { value: 'civil', label: 'Civil' }, { value: 'mech', label: 'Mechanical' }, { value: 'ei', label: 'E&I' }] } },
      { id: 'ref', label: 'Drawing', prompt: 'Which drawing or document does it concern?', input: { kind: 'text', placeholder: 'GA-200 rev B' } },
      { id: 'question', label: 'Question', prompt: 'What do you need to know?', input: { kind: 'text', multiline: true } },
      { id: 'proposal', label: 'Proposed answer', prompt: 'What would you propose? The client answers faster when there is a proposal. (optional)', input: { kind: 'text', multiline: true, optional: true } },
      { id: 'markup', label: 'Mark-up', prompt: 'Attach a mark-up if you have one.', input: { kind: 'file', accept: ['.pdf', '.png', '.jpg'], optional: true } },
      { id: 'due', label: 'Answer by', prompt: 'When do you need the answer?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      { id: 'ok', prompt: 'Send this TQ to your lead for review?\n\n{{summary}}', input: { kind: 'confirm' }, branches: [{ if: { equals: 'no' }, goto: 'job' }] },
    ],
    finish: [],
    done: 'Your TQ is logged and with your lead for review. This card shows where it is.',
    track: {
      ref: 'TQ', name: '{{job}} · {{discipline}} · {{ref}}',
      roles: { client: { label: 'Client interface' } },
      stages: [
        {
          id: 'review', label: 'Review', who: 'lead', dueInDays: 2,
          prompt: '{{user}} raises a TQ on {{ref}} ({{job}}, {{discipline}}):\n\n{{question}}\n\nProposed: {{proposal}}',
          actions: [
            { id: 'send', label: 'Send to the client', to: 'client', tone: 'go' },
            { id: 'answer', label: 'Answer it here', to: 'close', note: 'required', ask: 'Answer' },
            { id: 'reword', label: 'Ask to reword', to: 'reword', note: 'required', ask: 'What to change', tone: 'back' },
            { id: 'drop', label: 'Not needed', to: 'end', stamp: 'NOT NEEDED', outcome: 'stopped', note: 'required', ask: 'Why', tone: 'stop' },
          ],
        },
        {
          id: 'reword', label: 'Reword', who: 'requester',
          prompt: 'Your lead asks for a change before it goes to the client:\n\n{{note}}',
          actions: [{ id: 'again', label: 'Reworded, send again', to: 'review', note: 'required', ask: 'The question as it stands now', tone: 'go' }],
        },
        {
          id: 'client', label: 'With client', who: 'role:client', due: 'due',
          prompt: 'Send this TQ to the client and record their reply here. {{ref}} ({{job}}, {{discipline}}):\n\n{{question}}\n\nProposed: {{proposal}}',
          actions: [{ id: 'reply', label: 'Client replied', to: 'close', note: 'required', ask: 'The client’s reply', tone: 'go' }],
        },
        {
          id: 'close', label: 'Close out', who: 'requester', dueInDays: 3,
          prompt: 'The answer to your TQ on {{ref}}:\n\n{{note}}\n\nClose it once the answer is in the drawings, or ask again.',
          actions: [
            { id: 'close', label: 'Close the TQ', to: 'end', stamp: 'CLOSED', tone: 'go' },
            { id: 'again', label: 'Ask again', to: 'review', note: 'required', ask: 'What is still unclear', tone: 'back' },
          ],
        },
      ],
      remind: { afterHours: 48, times: 2, escalate: 'lead' },
      register: { to: 'role:client', at: '09:30', days: [1], columns: ['job', 'discipline', 'ref', 'due'] },
    },
  },
};

// ---------------------------------------------------------------- drawing check, back-check and issue
export const DRAWING_CHECK: OfficeTemplate = {
  id: 'drawing-issue', title: 'Drawing check and issue', about: 'Check, back-check, approve and issue on a transmittal, with the client’s receipt recorded.',
  definition: {
    name: 'drawing-issue', title: 'Drawing check and issue', description: 'Drawings through check, back-check, approval and issue on a transmittal.',
    persona: persona('stamp', 'teal', 'Check, back-check, approve and issue on a transmittal, with the client’s receipt recorded.', 'brief'),
    steps: [
      { id: 'job', label: 'Job', prompt: 'Which job?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
      { id: 'drawings', label: 'Drawings', prompt: 'Which drawings? One per line.', input: { kind: 'text', multiline: true, placeholder: 'ISO-1001-01\nISO-1001-02' } },
      { id: 'rev', label: 'Revision', prompt: 'At which revision?', input: { kind: 'text', placeholder: 'C', validate: { type: 'regex', pattern: '[A-Z]{1,2}|\\d{1,2}|[A-Z]\\d', message: 'Write the revision: a letter like C, or a number like 2.' }, suggestions: ['A', 'B', 'C', '0'] } },
      { id: 'purpose', label: 'Issued for', prompt: 'Issued for what?', input: { kind: 'choice', options: [{ value: 'IFR', label: 'Review (IFR)' }, { value: 'IFA', label: 'Approval (IFA)' }, { value: 'IFC', label: 'Construction (IFC)' }, { value: 'AB', label: 'As-built' }] } },
      { id: 'checker', label: 'Checker', prompt: 'Who checks them?', input: { kind: 'person' } },
      { id: 'print', label: 'Check print', prompt: 'Attach the check print if it is ready. (optional)', input: { kind: 'file', accept: ['.pdf'], optional: true } },
      { id: 'due', label: 'Issue by', prompt: 'Issue by when?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      { id: 'ok', prompt: 'Send to {{checker}} for checking?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send for check', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'drawings' }] },
    ],
    finish: [],
    done: 'With {{checker}} to check.',
    track: {
      ref: 'DC', name: '{{job}} · rev {{rev}} {{purpose.value}}',
      roles: { doccontrol: { label: 'Document control' } },
      stages: [
        {
          id: 'check', label: 'Check', who: 'checker', due: 'due',
          prompt: 'Check rev {{rev}} for {{purpose}} ({{job}}), from {{user}}, to issue by {{due}}:\n\n{{drawings}}',
          checklist: ['Title block, revision and status', 'Dimensions, elevations and tags', 'Against the latest model and P&ID', 'Notes, references and the bill of materials'],
          actions: [
            { id: 'pass', label: 'Checked, no comments', to: 'approve', needsChecks: true, tone: 'go' },
            { id: 'comments', label: 'Return with comments', to: 'correct', note: 'required', ask: 'Comments', tone: 'back' },
          ],
        },
        {
          id: 'correct', label: 'Correct', who: 'requester',
          prompt: 'Returned with comments:\n\n{{note}}\n\nCorrect the drawings, then send them for back-check.',
          actions: [{ id: 'done', label: 'Corrected, send for back-check', to: 'check', note: 'optional', ask: 'What changed', tone: 'go' }],
        },
        {
          id: 'approve', label: 'Approve', who: 'lead', due: 'due',
          prompt: 'Rev {{rev}} for {{purpose}} ({{job}}) is checked by {{checker}}. Approve it for issue?\n\n{{drawings}}',
          actions: [
            { id: 'ok', label: 'Approve for issue', to: 'issue', tone: 'go' },
            { id: 'back', label: 'Send back', to: 'correct', note: 'required', ask: 'Comments', tone: 'back' },
          ],
        },
        {
          id: 'issue', label: 'Issue', who: 'role:doccontrol', due: 'due',
          prompt: 'Issue rev {{rev}} for {{purpose}} ({{job}}) and write the transmittal number:\n\n{{drawings}}',
          actions: [{ id: 'issued', label: 'Issued on transmittal', to: 'receipt', note: 'required', ask: 'Transmittal number', tone: 'go' }],
        },
        {
          id: 'receipt', label: 'Client receipt', who: 'role:doccontrol', dueInDays: 5, task: false,
          prompt: 'Transmittal {{note}} ({{job}}, rev {{rev}}) is with the client. Record their acknowledgement when it comes.',
          actions: [{ id: 'ack', label: 'Client acknowledged', to: 'end', stamp: 'ISSUED', note: 'optional', ask: 'Acknowledgement reference', tone: 'go' }],
        },
      ],
      remind: { afterHours: 24, times: 2, escalate: 'lead' },
      register: { to: 'role:doccontrol', at: '09:20', days: WEEK, columns: ['job', 'rev', 'purpose', 'due'] },
    },
  },
};

// ---------------------------------------------------------------- software seats
export const SOFTWARE_SEAT: OfficeTemplate = {
  id: 'licence-seat', title: 'Software seat', about: 'Borrow an E3D, PDMS or AutoCAD seat; see who has one now, and wait in line when all are taken.',
  definition: {
    name: 'licence-seat', title: 'Software seat', description: 'Borrow a seat of E3D, PDMS, AutoCAD and the rest; release it when you are done.',
    persona: persona('key', 'slate', 'Borrow an E3D, PDMS or AutoCAD seat; see who has one now, and wait in line when all are taken.', 'brief'),
    keywords: ['seat', 'licence', 'license'],
    steps: [
      { id: 'software', label: 'Software', prompt: 'Which software?', input: { kind: 'choice', options: ['E3D', 'PDMS', 'AutoCAD Plant 3D', 'AutoCAD', 'Tekla Structures', 'STAAD.Pro', 'CAESAR II', 'Navisworks'].map((x) => ({ value: x, label: x })) } },
      { id: 'job', label: 'Job', prompt: 'For which job?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
    ],
    finish: [],
    done: 'Done.',
    track: {
      ref: 'LIC', name: '{{software}} · {{job}}',
      roles: { it: { label: 'IT desk' } },
      stages: [
        {
          id: 'use', label: 'In use', who: 'requester', task: false,
          prompt: 'The {{software}} seat is yours for {{job}}. Release it when you are done, so the next person can start.',
          limit: { by: 'software', seats: { E3D: 4, PDMS: 2, 'AutoCAD Plant 3D': 3, AutoCAD: 10, 'Tekla Structures': 2, 'STAAD.Pro': 2, 'CAESAR II': 1, Navisworks: 3 }, otherwise: 1 },
          actions: [
            { id: 'release', label: 'Release the seat', to: 'end', stamp: 'RELEASED', tone: 'go' },
            { id: 'keep', label: 'Still using it', to: 'use' },
          ],
        },
      ],
      remind: { afterHours: 8, times: 1, escalate: 'role:it' },
      register: { to: 'role:it', at: '17:45', days: WEEK6, columns: ['software', 'job'] },
    },
  },
};

// ---------------------------------------------------------------- working late
export const LATE_WORK: OfficeTemplate = {
  id: 'late-work', title: 'Late work request', about: 'Your lead approves; admin and security get one list of who stays late tonight, with cabs.',
  definition: {
    name: 'late-work', title: 'Late work request', description: 'Ask to work late; your lead approves and admin arranges security and the cab.',
    persona: persona('lamp', 'plum', 'Your lead approves; admin and security get one list of who stays late tonight, with cabs.', 'warm'),
    steps: [
      { id: 'day', label: 'Day', prompt: 'Which day?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
      { id: 'until', label: 'Until', prompt: 'Until what time?', input: { kind: 'choice', options: ['20:00', '21:00', '22:00', 'After 22:00'].map((x) => ({ value: x, label: x })) } },
      { id: 'job', label: 'Job', prompt: 'For which job?', input: { kind: 'text', placeholder: 'P-12513', validate: JOB, suggest: 'jobs' } },
      { id: 'why', label: 'Reason', prompt: 'What needs finishing?', input: { kind: 'text', placeholder: 'IFC isometrics for the client by 10 am' } },
      { id: 'cab', label: 'Cab home', prompt: 'Do you need a cab home?', input: { kind: 'choice', options: [{ value: 'yes', label: 'Yes, a cab home' }, { value: 'no', label: 'No' }] } },
      { id: 'ok', prompt: 'Send this to your lead?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'day' }] },
    ],
    finish: [],
    done: 'Sent to your lead. Admin arranges security and the cab once it is approved.',
    track: {
      ref: 'LW', name: '{{day}} · until {{until}}',
      roles: { admin: { label: 'Admin and security' } },
      stages: [
        {
          id: 'approve', label: 'Approve', who: 'lead', due: 'day',
          prompt: '{{user}} asks to work late on {{day}} until {{until}} for {{job}}: {{why}}. Cab home: {{cab}}.',
          actions: [
            { id: 'ok', label: 'Approve', to: 'arrange', tone: 'go' },
            { id: 'no', label: 'Not approved', to: 'end', stamp: 'NOT APPROVED', outcome: 'stopped', note: 'required', ask: 'Reason', tone: 'stop' },
          ],
        },
        {
          id: 'arrange', label: 'Arrange', who: 'role:admin', due: 'day',
          prompt: 'Approved: {{user}} works late on {{day}} until {{until}} ({{job}}). Cab home: {{cab}}. Tell security and arrange the cab.',
          actions: [{ id: 'done', label: 'Arranged', to: 'end', stamp: 'APPROVED', note: 'optional', ask: 'For them: cab number, gate', tone: 'go' }],
        },
      ],
      remind: { afterHours: 2, times: 2, escalate: 'none' },
      register: { to: 'role:admin', at: '16:30', days: WEEK6, columns: ['day', 'until', 'cab'] },
    },
  },
};
