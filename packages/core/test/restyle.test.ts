// The communication style rewriter: every style, what it must never touch, idempotence,
// change records that can be undone one at a time, and speed on long text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restyle, applyChoices, RESTYLE_STYLES, GLOSSARY, THIN_SPACE } from '../src/restyle.ts';
import type { RestyleStyle } from '../src/restyle.ts';

const r = (text: string, style: RestyleStyle, opts?: Parameters<typeof restyle>[2]) => restyle(text, style, opts).text;

// ------------------------------------------------------------------ concise

test('concise: drops greeting padding but keeps the greeting', () => {
  assert.equal(r('Hi Priya, hope you are doing well. Please send the MTO.', 'concise'), 'Hi Priya, please send the MTO.');
  assert.equal(r('Good morning team, I hope this mail finds you well. The GA is issued.', 'concise'), 'Good morning team, the GA is issued.');
  assert.equal(r('Dear Sir, Greetings of the day! Kindly find attached the BOQ.', 'concise'), 'Dear Sir, kindly find attached the BOQ.');
});

test('concise: removes fillers and hedges', () => {
  assert.equal(r('We just need to check the supports.', 'concise'), 'We need to check the supports.');
  assert.equal(r('Basically the pump is ready.', 'concise'), 'The pump is ready.');
  assert.equal(r('I think the nozzle load is fine.', 'concise'), 'The nozzle load is fine.');
  assert.equal(r('Please note that the site visit is moved.', 'concise'), 'The site visit is moved.');
  assert.equal(r('The model is kind of complete.', 'concise'), 'The model is complete.');
  assert.equal(r('It is fine, basically.', 'concise'), 'It is fine.');
});

test('concise: keeps words that carry meaning', () => {
  assert.equal(r('I just now sent it.', 'concise'), 'I just now sent it.');
  assert.equal(r('It was not really clear.', 'concise'), 'It was not really clear.');
  assert.equal(r('I think so.', 'concise'), 'I think so.');
});

test('concise: collapses wordy phrases', () => {
  assert.equal(r('We revised it in order to close the RFI.', 'concise'), 'We revised it to close the RFI.');
  assert.equal(r('At this point in time the IFC set is pending.', 'concise'), 'Now the IFC set is pending.');
  assert.equal(r('It is late due to the fact that the vendor data changed.', 'concise'), 'It is late because the vendor data changed.');
  assert.equal(r('We check it on a daily basis prior to issue.', 'concise'), 'We check it daily before issue.');
});

test('concise: merges repeated words', () => {
  assert.equal(r('Send the the file to to Ravi.', 'concise'), 'Send the file to Ravi.');
});

// ------------------------------------------------------------------ formal

test('formal: expands contractions', () => {
  assert.equal(r("We can't issue it, it's not checked.", 'formal'), 'We cannot issue it, it is not checked.');
  assert.equal(r("I'll send it. They've seen it. Don't worry.", 'formal'), 'I will send it. They have seen it. Do not worry.');
  assert.equal(r("It's been a week.", 'formal'), 'It has been a week.');
});

test('formal: replaces casual words and shorthand', () => {
  assert.equal(r('pls send asap', 'formal'), 'Please send as soon as possible.');
  assert.equal(r('yeah gonna do it tmrw, thx', 'formal'), 'Yes going to do it tomorrow, thank you.');
  assert.equal(r('FYI the GA is out', 'formal'), 'For your information the GA is out.');
  assert.equal(r('btw u r right', 'formal'), 'By the way you are right.');
});

test('formal: Indian-English office shorthand', () => {
  assert.equal(r('Kindly do the needful.', 'formal'), 'Please take the necessary action.');
  assert.equal(r('Please revert back by today itself.', 'formal'), 'Please reply by today.');
  assert.equal(r('The meeting is preponed to Monday.', 'formal'), 'The meeting is brought forward to Monday.');
  assert.equal(r('Kindly intimate the status.', 'formal'), 'Please inform the status.');
  assert.equal(r('pfa the MTO', 'formal'), 'Please find attached the MTO.');
});

test('formal: TQ and U-bend in capitals are not chat shorthand', () => {
  assert.equal(r('Raise a TQ for the U bend.', 'formal'), 'Raise a TQ for the U bend.');
  assert.equal(r('ok tq', 'formal'), 'Okay thank you.');
});

test('formal: sentence capitals and end punctuation', () => {
  assert.equal(r('the iso is ready. i will send it', 'formal'), 'The iso is ready. I will send it.');
  assert.equal(r('Hi Ravi\nthe GA is issued\nRegards\nPriya', 'formal'), 'Hi Ravi,\nThe GA is issued.\nRegards,\nPriya');
  assert.equal(r('hello please check', 'formal'), 'Hello, please check.');
});

test('formal: stacked marks and emoji filler go', () => {
  assert.equal(r('Done!!!', 'formal'), 'Done!');
  assert.equal(r('Really???', 'formal'), 'Really?');
  assert.equal(r('Great work 👍👍 team', 'formal'), 'Great work team.');
  assert.equal(r('Thanks 🙏', 'formal'), 'Thanks.');
  assert.equal(r('Sent the file\n😊😊\nRavi', 'formal'), 'Sent the file.\nRavi');
  assert.equal(r('haha ok fine :)', 'formal'), 'Okay fine.');
});

test('formal: a list of 150+ casual entries is in effect', () => {
  // a sample across the list: each must change
  for (const w of ['plz', 'thnx', 'gonna', 'wanna', 'dunno', 'lemme', 'idk', 'imo', 'tbh', 'b4', 'cuz', 'abt', 'msg', 'info', 'gud', 'rgds', 'reqd', 'chk', 'dwgs', 'mgmt', 'updation', 'prepone']) {
    assert.notEqual(r(`the ${w} here`, 'formal'), `The ${w} here.`, w);
  }
});

// ------------------------------------------------------------------ diplomatic

test('diplomatic: imperatives become requests', () => {
  assert.equal(r('Send the file.', 'diplomatic', { courtesy: false }), 'Could you send the file?');
  assert.equal(r('Please update the BOQ!', 'diplomatic', { courtesy: false }), 'Could you please update the BOQ?');
  assert.equal(r('Let me know by EOD.', 'diplomatic', { courtesy: false }), 'Could you let me know by EOD?');
  assert.equal(r('You need to fix the clash.', 'diplomatic', { courtesy: false }), 'Could you fix the clash?');
  assert.equal(r("Don't change the GA.", 'diplomatic', { courtesy: false }), "Please don't change the GA.");
});

test('diplomatic: nouns and attachments are not requests', () => {
  assert.equal(r('Check valve is installed.', 'diplomatic', { courtesy: false }), 'Check valve is installed.');
  assert.equal(r('Please find attached the MTO.', 'diplomatic', { courtesy: false }), 'Please find attached the MTO.');
  assert.equal(r('Plot plan is approved.', 'diplomatic', { courtesy: false }), 'Plot plan is approved.');
});

test('diplomatic: blame becomes a neutral observation', () => {
  assert.equal(r("You didn't send the MTO.", 'diplomatic', { courtesy: false }), "It looks like the MTO hasn't yet been sent.");
  assert.equal(r('You have not updated... you did not update the isometrics yet.', 'diplomatic', { courtesy: false }).includes("the isometrics haven't yet been updated"), true);
  assert.equal(r("You forgot to attach the drawings.", 'diplomatic', { courtesy: false }), "It looks like the drawings haven't yet been attached.");
  assert.equal(r("You didn't reply to me.", 'diplomatic', { courtesy: false }), "It looks like you haven't had a chance to reply to me yet.");
});

test('diplomatic: absolutes are softened only about people', () => {
  assert.equal(r('You always miss the cut-off.', 'diplomatic', { courtesy: false }), 'You often miss the cut-off.');
  assert.equal(r('They are never on time.', 'diplomatic', { courtesy: false }), 'They are rarely on time.');
  assert.equal(r('Always use the latest revision.', 'diplomatic', { courtesy: false }), 'Always use the latest revision.');
  assert.equal(r('Never weld near the PSV.', 'diplomatic', { courtesy: false }), 'Never weld near the PSV.');
});

test('diplomatic: harsh wording softened', () => {
  assert.equal(r('This is wrong.', 'diplomatic', { courtesy: false }), "This doesn't look quite right.");
  assert.equal(r('As I already said, the line is 6".', 'diplomatic', { courtesy: false }), 'As mentioned, the line is 6".');
});

test('diplomatic: adds a greeting and thanks only when missing', () => {
  assert.equal(r('Send the GA by 5 pm today.', 'diplomatic'), 'Hi,\nCould you send the GA by 5 pm today?\nThank you.');
  assert.equal(r('Hi Ravi, could you check the supports? Thanks.', 'diplomatic'), 'Hi Ravi, could you check the supports? Thanks.');
  assert.equal(r('@priya send the GA', 'diplomatic'), 'Hi @priya, could you send the GA?\nThank you.');
});

test('diplomatic: never weakens a deadline or a number', () => {
  const out = r('Submit 12 isometrics by 14 Nov 2026 5:00 pm. You must close RFI-0042 today.', 'diplomatic');
  for (const keep of ['12 isometrics', '14 Nov 2026', '5:00 pm', 'RFI-0042', 'today']) assert.ok(out.includes(keep), `${keep} in ${out}`);
  assert.ok(out.includes('make sure to close RFI-0042 today'), out);
});

// ------------------------------------------------------------------ explanatory

test('explanatory: What / Why / Next from cause and action cues', () => {
  assert.equal(r('We need to revise the GA because the nozzle moved.', 'explanatory'), 'Why: The nozzle moved.\nNext: We need to revise the GA (general arrangement drawing).');
  assert.equal(r('The vendor data is late, so the layout is on hold.', 'explanatory'), 'What: The layout is on hold.\nWhy: The vendor data is late.');
  assert.equal(r('Hi Ravi,\nThe pump moved 200 mm. Please update the isometrics.\nThanks', 'explanatory'),
    'Hi Ravi,\nWhat: The pump moved 200 mm.\nNext: Please update the isometrics.\nThanks');
});

test('explanatory: plain statements are not restructured', () => {
  assert.equal(r('The site visit went well.', 'explanatory'), 'The site visit went well.');
});

test('explanatory: abbreviations expanded on first use only', () => {
  assert.equal(r('The MTO is ready. The MTO has 40 lines.', 'explanatory'), 'The MTO (material take-off) is ready. The MTO has 40 lines.');
  assert.equal(r('Two RFIs are open.', 'explanatory'), 'Two RFIs (requests for information) are open.');
  assert.equal(r('The P&ID shows a PSV.', 'explanatory'), 'The P&ID (piping and instrumentation diagram) shows a PSV (pressure safety valve).');
  assert.equal(r('The MTO (material take-off) is ready.', 'explanatory'), 'The MTO (material take-off) is ready.');
});

test('explanatory: relative times spelled out', () => {
  assert.equal(r('The NCR closes EOD.', 'explanatory'), 'The NCR (non-conformance report) closes end of day.');
  assert.equal(r('Back tmrw, report by COB.', 'explanatory'), 'Back tomorrow, report by close of business.');
});

test('explanatory: glossary has 120+ entries and takes the office\'s own', () => {
  assert.ok(GLOSSARY.length >= 120, String(GLOSSARY.length));
  assert.equal(r('Check the SPDS.', 'explanatory', { glossary: { SPDS: 'site plot drawing set' } }), 'Check the SPDS (site plot drawing set).');
});

// ------------------------------------------------------------------ technical

test('technical: units with SI symbols and a thin space', () => {
  assert.equal(r('Use 40mm and 2 mtrs.', 'technical'), `Use 40${THIN_SPACE}mm and 2${THIN_SPACE}m.`);
  assert.equal(r('Design 1500 kpag at 120 degC.', 'technical'), `Design 1500${THIN_SPACE}kPa(g) at 120${THIN_SPACE}°C.`);
  assert.equal(r('Flow 25 m3/hr, 3 barg.', 'technical'), `Flow 25${THIN_SPACE}m³/h, 3${THIN_SPACE}bar(g).`);
  assert.equal(r('Weight 12 kgs.', 'technical'), `Weight 12${THIN_SPACE}kg.`);
});

test('technical: approx becomes ≈ and numbers stay exact', () => {
  assert.equal(r('Load is approx 4.25 kN.', 'technical'), `Load is ≈ 4.25${THIN_SPACE}kN.`);
  assert.equal(r('About 1,20,000 nos.', 'technical'), '≈ 1,20,000 nos.');
  assert.equal(r('The span is ~6 m.', 'technical'), `The span is ≈ 6${THIN_SPACE}m.`);
});

test('technical: the abbreviation after first full use', () => {
  assert.equal(r('The material take-off is ready. Check the material take-off.', 'technical'), 'The material take-off (MTO) is ready. Check the MTO.');
  assert.equal(r('Raise a request for information, then two requests for information.', 'technical'), 'Raise a request for information (RFI), then two RFIs.');
  assert.equal(r('The MTO is out. The material take-off is final.', 'technical'), 'The MTO is out. The MTO is final.');
});

test('technical: precise terms', () => {
  assert.equal(r('Check the temp and the dia.', 'technical'), 'Check the temperature and the diameter.');
});

test('technical: lists of quantities become bullets', () => {
  assert.equal(r('Need 40 elbows, 12 tees, 6 reducers and 3 flanges.', 'technical'), 'Need:\n- 40 elbows\n- 12 tees\n- 6 reducers\n- 3 flanges');
  assert.equal(r('Pending: GA, isometrics, MTO and BOQ.', 'technical'), 'Pending:\n- GA\n- isometrics\n- MTO\n- BOQ');
  assert.equal(r('We need 2 pumps and 1 vessel.', 'technical'), 'We need 2 pumps and 1 vessel.');
});

// ------------------------------------------------------------------ preservation

const SAMPLE = 'pls check 6"-P-1001-A1A and P-12513 on ISO-0042 Rev B, 40-120 supports, 12.5 mm, ₹ 5,00,000, 14/11/2026 at 5.30 pm, '
  + '@priya.raman <@01HZX4Q9V8J3K2M5N6P7R8S9T0> https://dexterity.example/a?b=1 dexconnect://message/01A/01B `x=1` "do NOT change" \\\\fs01\\Projects\\P-12513 '
  + 'sleuth://search?q=ISO-1001 and kindly revert asap!!! thx';
const KEEP = ['6"-P-1001-A1A', 'P-12513', 'ISO-0042 Rev B', '40-120', '12.5 mm', '₹ 5,00,000', '14/11/2026', '5.30 pm', '@priya.raman',
  '<@01HZX4Q9V8J3K2M5N6P7R8S9T0>', 'https://dexterity.example/a?b=1', 'dexconnect://message/01A/01B', '`x=1`', '"do NOT change"',
  '\\\\fs01\\Projects\\P-12513', 'sleuth://search?q=ISO-1001'];

for (const style of RESTYLE_STYLES) {
  test(`preservation (${style}): tags, numbers, mentions, links, code and quotes are byte-identical`, () => {
    const out = r(SAMPLE, style);
    for (const k of KEEP) {
      // technical writes a thin space between a number and its unit; the digits stay
      const want = style === 'technical' && k === '12.5 mm' ? `12.5${THIN_SPACE}mm` : k;
      assert.ok(out.includes(want), `${style} lost ${JSON.stringify(k)}: ${out}`);
    }
  });

  test(`idempotence (${style}): restyling twice equals once`, () => {
    for (const t of [SAMPLE, 'hey pls send the iso asap!!! thx 🙏', 'You didn\'t update the BOQ. Send the GA.', 'Need approx 40 elbows, 12 tees and 6 reducers.',
      'Hi Priya, hope you are well. I think the MTO is basically ready due to the fact that we checked it.', 'The material take-off is late because the RFI is open, so please chase the vendor by EOD.']) {
      const once = r(t, style);
      assert.equal(r(once, style), once, `${style}: ${t}`);
    }
  });
}

test('names given by the caller are never touched', () => {
  assert.equal(r('Ask Will about it. Will says ok.', 'formal', { names: ['Will'] }), 'Ask Will about it. Will says okay.');
  assert.equal(r('Send it to Ty.', 'formal', { names: ['Ty'] }), 'Send it to Ty.');
});

test('mixed Hindi and English is left intact', () => {
  const hi = 'कृपया drawing भेजें, बहुत बहुत धन्यवाद';
  for (const style of RESTYLE_STYLES) {
    const out = r(hi, style);
    for (const part of ['कृपया', 'भेजें', 'बहुत बहुत धन्यवाद']) assert.ok(out.includes(part), `${style}: ${out}`);
  }
  assert.equal(r('Sir, kal tak MTO bhej dena pls', 'formal').includes('kal tak MTO bhej dena please'), true);
  assert.equal(r('आज शाम तक GA भेज दीजिए', 'formal'), 'आज शाम तक GA भेज दीजिए');
});

test('an empty string and a blank one', () => {
  for (const style of RESTYLE_STYLES) {
    assert.deepEqual(restyle('', style), { text: '', changes: [] });
    assert.deepEqual(restyle('   ', style), { text: '   ', changes: [] });
  }
});

test('changes: from/to/rule, positions, and undo one at a time', () => {
  const src = 'pls send the GA asap!!!';
  const res = restyle(src, 'formal');
  assert.equal(res.text, 'Please send the GA as soon as possible!');
  assert.ok(res.changes.length >= 3);
  for (const c of res.changes) {
    assert.equal(res.text.slice(c.at, c.at + c.to.length), c.to);
    assert.equal(src.slice(c.sourceAt, c.sourceAt + c.from.length), c.from);
    assert.match(c.rule, /^formal\./);
  }
  // rejecting everything gives the original back; rejecting one change undoes only that one
  assert.equal(applyChoices(res, res.changes.map((c) => c.id)), src);
  assert.equal(applyChoices(res, []), res.text);
  const asap = res.changes.find((c) => c.from === 'asap')!;
  assert.equal(applyChoices(res, [asap.id]), 'Please send the GA asap!');
});

test('every style keeps its edits undoable to the original', () => {
  const src = "Hi Priya, hope you are well. You didn't send the MTO for P-12513 because the vendor is late, so please chase approx 40 mm supports by EOD!!";
  for (const style of RESTYLE_STYLES) {
    const res = restyle(src, style);
    assert.equal(applyChoices(res, res.changes.map((c) => c.id)), src, style);
  }
});

test('unknown style or text that is not a string changes nothing', () => {
  assert.deepEqual(restyle('pls send', 'shouty' as RestyleStyle), { text: 'pls send', changes: [] });
  assert.deepEqual(restyle(42 as unknown as string, 'formal'), { text: '', changes: [] });
});

test('50 KB of text restyles in under 50 ms in every style', () => {
  const para = "Hi team, hope you are doing well. pls note that we basically need approx 40 elbows, 12 tees and 6 reducers for P-12513 asap!!! "
    + "You didn't update the BOQ because the vendor data is late, so please chase it by EOD. The material take-off is on \\\\fs01\\Projects. thx 🙏\n";
  const big = para.repeat(Math.ceil(50_000 / para.length)).slice(0, 50_000);
  for (const style of RESTYLE_STYLES) restyle(big.slice(0, 2000), style); // warm up the regex compiler
  for (const style of RESTYLE_STYLES) {
    const t0 = performance.now();
    const res = restyle(big, style);
    const ms = performance.now() - t0;
    assert.ok(res.text.length > 0);
    assert.ok(ms < 50, `${style} took ${ms.toFixed(1)} ms`);
  }
});

// ------------------------------------------------------------------ more cases

test('concise: hedges in the middle of a sentence', () => {
  assert.equal(r('The load is, I think, within limits.', 'concise'), 'The load is, within limits.');
  assert.equal(r('For all intents and purposes the model is done.', 'concise'), 'The model is done.');
  assert.equal(r('We are in the process of revising the GA.', 'concise'), 'We are revising the GA.');
});

test('concise: a total of and as per', () => {
  assert.equal(r('A total of 40 supports as per the PMS.', 'concise'), '40 supports per the PMS.');
});

test('concise: leaves Hindi reduplication alone', () => {
  assert.equal(r('jaldi jaldi send karo, bahut bahut thanks', 'concise'), 'jaldi jaldi send karo, bahut bahut thanks');
});

test('formal: contractions with curly apostrophes', () => {
  assert.equal(r('We don’t have it, it’s with QC.', 'formal'), 'We do not have it, it is with QC.');
});

test('formal: a greeting line gets its comma before the message', () => {
  assert.equal(r('Hello all\nthe site visit is on Friday', 'formal'), 'Hello all,\nThe site visit is on Friday.');
});

test('formal: abbreviations with a full stop do not start a sentence', () => {
  assert.equal(r('check e.g. the nozzle loads', 'formal'), 'Check e.g. the nozzle loads.');
});

test('formal: a URL at the end gets no full stop after it', () => {
  assert.equal(r('pls see https://dexterity.example/p/12513', 'formal'), 'Please see https://dexterity.example/p/12513');
});

test('diplomatic: a request addressed to someone keeps the mention first', () => {
  assert.equal(r('@ravi.k check the supports by 4 pm.', 'diplomatic', { courtesy: false }), '@ravi.k, could you check the supports by 4 pm?');
});

test('diplomatic: "you should" and "you must"', () => {
  assert.equal(r('You should recheck the loads.', 'diplomatic', { courtesy: false }), 'It would help if you could recheck the loads.');
  assert.equal(r('You must issue the IFC set by 14 Nov 2026.', 'diplomatic', { courtesy: false }), 'Please make sure to issue the IFC set by 14 Nov 2026.');
});

test('diplomatic: a question is left as it is', () => {
  assert.equal(r('Can you send the GA?', 'diplomatic', { courtesy: false }), 'Can you send the GA?');
});

test('diplomatic: thanks go before a signature', () => {
  assert.equal(r('Send the BOQ.\nRavi', 'diplomatic'), 'Hi,\nCould you send the BOQ?\nThank you.\nRavi');
});

test('explanatory: "Since …," leads with the reason', () => {
  assert.equal(r('Since the vendor changed the nozzle, please update the GA.', 'explanatory'),
    'Why: The vendor changed the nozzle.\nNext: Please update the GA (general arrangement drawing).');
});

test('explanatory: an existing structure is not structured again', () => {
  const t = 'What: The pump moved.\nNext: Update the isometrics.';
  assert.equal(r(t, 'explanatory'), t);
});

test('explanatory: ISO 9001 is a standard, not an isometric', () => {
  assert.equal(r('We follow ISO 9001.', 'explanatory'), 'We follow ISO 9001.');
});

test('technical: inches and feet stay as written', () => {
  assert.equal(r('Use 6" and 8" lines, 5\' clearance.', 'technical'), 'Use 6" and 8" lines, 5\' clearance.');
});

test('technical: "in" after a number is a word, not inches', () => {
  assert.equal(r('Found 40 in the yard.', 'technical'), 'Found 40 in the yard.');
});

test('technical: existing abbreviations are used for later full terms', () => {
  assert.equal(r('The P&ID is out; the piping and instrumentation diagram has 3 PSVs.', 'technical'), 'The P&ID is out; the P&ID has 3 PSVs.');
});

test('every change carries a rule of its style', () => {
  for (const style of RESTYLE_STYLES) {
    const res = restyle("hey pls basically send the GA asap!!! You didn't update the material take-off because of approx 40 mm, so please chase the RFI by EOD 🙏", style);
    assert.ok(res.changes.length > 0, style);
    for (const c of res.changes) for (const rule of c.rule.split('+')) assert.ok(rule.startsWith(`${style}.`), `${style}: ${c.rule}`);
  }
});

test('a text larger than the limit comes back unchanged', () => {
  const huge = 'pls '.repeat(60_000);
  assert.deepEqual(restyle(huge, 'formal'), { text: huge, changes: [] });
});

test('placeholder characters already in the text are kept', () => {
  const t = 'pls keep  here';
  const out = r(t, 'formal');
  assert.ok(out.includes(''), out);
  assert.ok(out.startsWith('Please keep'), out);
});
