import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, rowsFromSheet, toCsv } from '../src/index.ts';

test('CSV: quotes, embedded commas and newlines, BOM, Excel semicolons', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nthen left"\r\n\r\n'), [['a', 'b'], ['x, y', 'he said "hi"\nthen left']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('people sheets map common column names and dates', () => {
  const { rows, columns } = rowsFromSheet(parseCsv('Windows Account,Full Name,Designation,Dept,Reporting Manager,Ext.,DOJ,DOB,Blood group\nDEX\\priya,Priya Raman,Designer,Piping,vikram,214,12/04/2021,9-Jul-1990,O+\n'));
  assert.deepEqual(columns.map((c) => c.maps), ['account', 'displayName', 'title', 'department', 'manager', 'extension', 'joinedOn', 'birthday', 'custom field']);
  assert.deepEqual(rows[0], { account: 'DEX\\priya', displayName: 'Priya Raman', title: 'Designer', department: 'Piping', manager: 'vikram', extension: '214', joinedOn: '2021-04-12', birthday: '07-09', fields: { 'Blood group': 'O+' } });
});

test('CSV out: quoting and formula-safe cells', () => {
  assert.equal(toCsv([['Name', 'Note'], ['Priya', 'a, "b"'], ['=SUM(A1)', -3]]), '﻿Name,Note\r\nPriya,"a, ""b"""\r\n\'=SUM(A1),-3\r\n');
});
