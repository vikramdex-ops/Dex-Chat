// Flows the hub ships with, kept by its own integration, Front Office. Administrators can change
// them, switch them off, or revoke Front Office in Control room → Integrations.
import type { BotFlowDefinition } from '@dex/core';

export const FRONT_OFFICE_ACCOUNT = 'system\\front-office';
export const FRONT_OFFICE_NAME = 'Front Office';

/** Plots go through the discipline lead before the plot room spends roll and toner on them. */
export const PLOT_REQUEST: BotFlowDefinition = {
  name: 'plot-request',
  title: 'Request a plot',
  description: 'Send a plot set to the plot room. Your discipline lead approves it from their Desk.',
  command: 'plot',
  keywords: ['plot', 'plots', 'plotting', 'print drawings', 'plot request'],
  steps: [
    {
      id: 'job', label: 'Job', prompt: 'Which job is the plot for? Write the job number, for example P-12513.',
      input: { kind: 'text', placeholder: 'P-12513', validate: { type: 'regex', pattern: '[A-Za-z]{1,4}-?\\d{3,6}', message: 'Write the job number: letters then digits, like P-12513.' } },
    },
    {
      id: 'drawings', label: 'Drawings', prompt: 'Which drawings, at which revision? One per line.',
      input: { kind: 'text', multiline: true, placeholder: 'ISO-1001-01 rev C\nGA-200 rev B' },
    },
    {
      id: 'set', label: 'Plot set', prompt: 'Attach the plot set if it is not in the job folder (PDF, DWF or a zip).',
      input: { kind: 'file', accept: ['.pdf', '.dwf', '.dwfx', '.plt', '.tif', '.tiff', '.zip'], optional: true },
    },
    {
      id: 'size', label: 'Sheet size', prompt: 'Which sheet size?',
      input: { kind: 'choice', options: [{ value: 'A0', label: 'A0' }, { value: 'A1', label: 'A1' }, { value: 'A2', label: 'A2' }, { value: 'A3', label: 'A3 on the desk printer' }] },
      branches: [{ if: { equals: 'A3' }, goto: 'copies', set: { media: 'Plain paper' } }],
    },
    {
      id: 'media', label: 'Media', prompt: 'Which media?',
      input: { kind: 'choice', options: [{ value: 'bond', label: 'Bond: check prints' }, { value: 'film', label: 'Tracing film: issue set' }, { value: 'matte', label: 'Photo matte: presentation' }] },
    },
    {
      id: 'copies', label: 'Sets', prompt: 'How many sets?',
      input: { kind: 'text', placeholder: '1', validate: { type: 'number', integer: true, min: 1, max: 50, message: 'Write how many sets: a whole number from 1 to 50.' } },
    },
    {
      id: 'due', label: 'Needed by', prompt: 'When do you need them?',
      input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } },
    },
    {
      id: 'approver', label: 'Approver', prompt: 'Who approves this plot? Usually your discipline lead.',
      input: { kind: 'person' },
    },
    {
      id: 'check', prompt: 'Send this plot request to {{approver}}?\n\n{{summary}}',
      input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' },
      branches: [{ if: { equals: 'no' }, goto: 'job' }],
    },
  ],
  finish: [
    { do: 'task', assignee: 'approver', text: 'Approve plot for {{job}}: {{copies}} × {{size}} ({{media}}) for {{user}}, needed {{due}}', due: 'due' },
    { do: 'post', to: 'origin', text: '**Plot request for {{job}}** sent to {{approver}} for approval.\n\n{{summary}}' },
  ],
  done: 'Sent. It is on {{approver}}\'s Desk, due {{due}}. The plot room starts once it is approved.',
};

/** Leave goes to the approver's Desk; the person covering hears about it straight away. */
export const LEAVE_REQUEST: BotFlowDefinition = {
  name: 'leave-request',
  title: 'Leave request',
  description: 'Ask for leave. Your approver gets it on their Desk and whoever covers for you is told.',
  command: 'leave',
  keywords: ['leave', 'holiday', 'time off', 'vacation', 'leave request'],
  steps: [
    {
      id: 'kind', label: 'Leave', prompt: 'What kind of leave?',
      input: { kind: 'choice', options: [{ value: 'casual', label: 'Casual leave' }, { value: 'sick', label: 'Sick leave' }, { value: 'earned', label: 'Earned leave' }, { value: 'comp-off', label: 'Compensatory off' }] },
    },
    {
      id: 'from', label: 'From', prompt: 'From which day?',
      input: { kind: 'text', validate: { type: 'date' } },
    },
    {
      id: 'days', label: 'Working days', prompt: 'How many working days? Half days are fine, like 0.5 or 1.5.',
      input: { kind: 'text', placeholder: '1', validate: { type: 'number', min: 0.5, max: 60, message: 'Write the number of working days, from 0.5 to 60.' } },
    },
    {
      id: 'cover', label: 'Covering', prompt: 'Who covers your work while you are away?',
      input: { kind: 'person', optional: true },
    },
    {
      id: 'handover', label: 'Handover', prompt: 'Anything they should know? Open RFIs, site visits, deadlines.',
      input: { kind: 'text', multiline: true, optional: true },
    },
    {
      id: 'approver', label: 'Approver', prompt: 'Who approves your leave?',
      input: { kind: 'person' },
    },
    {
      id: 'check', prompt: 'Send this leave request to {{approver}}?\n\n{{summary}}',
      input: { kind: 'confirm', yes: 'Send for approval', no: 'Change something' },
      branches: [{ if: { equals: 'no' }, goto: 'kind' }],
    },
  ],
  finish: [
    { do: 'task', assignee: 'approver', text: 'Approve {{kind}} for {{user}}: {{days}} working day(s) from {{from}}', due: 'from' },
    { do: 'post', to: 'person:cover', text: '{{user}} is on {{kind}} from {{from}} ({{days}} working days) and asked you to cover.\n\nHandover: {{handover}}' },
  ],
  done: 'Sent to {{approver}}. It is on their Desk.',
};

export const BUILTIN_FLOWS: BotFlowDefinition[] = [PLOT_REQUEST, LEAVE_REQUEST];
