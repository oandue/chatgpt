// FDE 가상 데이터 시연 — 엔진 행동 검증 (의존성 없음)
// 실행: node tests.cjs
// index.html 안의 <script id="fde-data">, <script id="fde-core">를 그대로 꺼내 실행한다.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function extract(id) {
  const m = html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) throw new Error('script#' + id + ' 없음');
  return m[1];
}
function load() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extract('fde-data'), ctx);
  vm.runInContext(extract('fde-core'), ctx);
  return { D: ctx.FDE_DATA, F: ctx.FDE };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const plain = (x) => JSON.parse(JSON.stringify(x));

// 독립 계산(엔진 함수를 쓰지 않음)
function countBy(docs, key) { const o = {}; docs.forEach((d) => { o[d[key]] = (o[d[key]] || 0) + 1; }); return o; }
function fams(docs) { return new Set(docs.map((d) => d.familyId)).size; }

test('1. 가상 데이터 기대 건수: V1 36건·18패밀리·국내 24건, 후보 6건', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const v1 = F.docsInBaseline(s, 'V1');
  assert.strictEqual(v1.length, 36);
  assert.strictEqual(fams(v1), 18);
  assert.strictEqual(v1.filter((d) => d.country === 'KR').length, 24);
  assert.deepStrictEqual(plain(countBy(v1, 'year')), { 2020: 3, 2021: 4, 2022: 5, 2023: 6, 2024: 8, 2025: 10 });
  assert.strictEqual(s.candidates.length, 6);
  const ids = D.DOCS.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'DEMO ID 중복');
  assert.ok(ids.every((id) => /^DEMO-(KR|US|JP|EP|CN)-\d{4}$/.test(id)));
  assert.strictEqual(D.TASKS.length, 3);
  assert.strictEqual(D.CARDS.length, 6);
  D.CARDS.forEach((c) => c.evidence.forEach((id) => assert.ok(s.baselines[0].docIds.includes(id), c.id + ' 근거 ' + id + '가 V1에 없음')));
});

test('2. 배열 집계가 독립 계산과 일치 (연도·수단·분류·출원인)', () => {
  const { F } = load();
  const s = F.createInitialState();
  const v1 = F.docsInBaseline(s, 'V1');
  const byYear = countBy(v1, 'year');
  const r = F.runAnalysis(s, { groupBy: 'year', unit: 'doc', filters: {} });
  r.rows.forEach((row) => assert.strictEqual(row.count, byYear[row.key] || 0));
  ['mech', 'sub', 'applicant'].forEach((g) => {
    const exp = countBy(v1, g);
    const rr = F.runAnalysis(s, { groupBy: g, unit: 'doc', filters: {} });
    rr.rows.forEach((row) => assert.strictEqual(row.count, exp[row.key] || 0, g + ' ' + row.key));
    assert.strictEqual(rr.rowSum, 36);
  });
});

test('3. 후보 영역은 승인 전 집계·검색·질문에 섞이지 않음', () => {
  const { F } = load();
  const s = F.createInitialState();
  const candIds = s.candidates.map((c) => c.docId);
  F.ask(s, '연도별 추세를 보여 주세요');
  const run = s.runs[s.ctx.runId];
  assert.strictEqual(run.totals.docs, 36);
  assert.ok(!run.docIds.some((id) => candIds.includes(id)));
  assert.ok(!run.rows.some((r) => r.key === 2026), '후보 연도 2026이 V1 그래프에 나타남');
  const found = F.searchAll(s, '자석 댐퍼', {});
  assert.ok(!found.docs.some((d) => candIds.includes(d.id)));
  const m = F.ask(s, 'DEMO-KR-0026');
  assert.strictEqual(m.inBaseline, false);
});

test('4. 후속 질문: "그중 국내만"이 연도별 보기를 유지하고 국가 조건을 추가', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '연도별 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const run = s.runs[m.runId];
  assert.strictEqual(run.spec.groupBy, 'year');
  assert.strictEqual(run.spec.filters.country, 'KR');
  assert.strictEqual(run.totals.docs, 24);
  assert.deepStrictEqual(plain(m.changes.added), ['국가: 국내(한국)만']);
  assert.deepStrictEqual(plain(run.rows.map((r) => r.count)), [2, 2, 2, 4, 5, 9]);
});

test('5. 패밀리 단위: 중복 제거, 연도별 합과 전체 고유 수를 구분', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '연도별 추세를 보여 주세요');
  F.ask(s, '그중 국내만');
  const m = F.ask(s, '패밀리 단위로 보여 주세요');
  const run = s.runs[m.runId];
  assert.strictEqual(run.spec.unit, 'family');
  assert.strictEqual(run.spec.filters.country, 'KR', '국내 조건 유지');
  const kr = F.docsInBaseline(s, 'V1').filter((d) => d.country === 'KR');
  assert.strictEqual(run.totals.families, fams(kr));
  assert.strictEqual(run.totals.families, 14);
  run.rows.forEach((r) => assert.strictEqual(r.count, fams(kr.filter((d) => d.year === r.key))));
  assert.ok(run.rowSum > run.totals.families, '연도별 합이 고유 패밀리보다 커야 함(연도 간 중복)');
  assert.ok(F.describeRun(run).some((l) => l.includes('다릅니다')));
});

test('6. 검색 범위 유지와 새 주제의 조건 변경 표시', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '연도별 추세를 보여 주세요');
  F.ask(s, '그중 국내만');
  const t = F.ask(s, '흔들림을 줄이는 방식은 무엇인가요?');
  assert.ok(t.changes.newTopic);
  assert.ok(t.changes.removed.includes('국가: 국내(한국)만'), '해제된 조건이 표시되어야 함');
  assert.strictEqual(s.runs[t.runId].spec.filters.sub, 'T2');
  const f = F.ask(s, '연도별로 보여 주세요');
  const run = s.runs[f.runId];
  assert.strictEqual(run.spec.filters.sub, 'T2', '흔들림 범위 유지');
  assert.ok(f.changes.kept.includes('분류: 흔들림 억제'));
  const k = F.ask(s, '그중 쐐기만');
  assert.strictEqual(s.runs[k.runId].spec.filters.mech, '쐐기');
  assert.strictEqual(s.runs[k.runId].spec.filters.sub, 'T2');
  F.ask(s, '조건 초기화');
  assert.strictEqual(s.ctx, null);
});

test('7. 저장 결과는 V2 공개 후에도 바뀌지 않음 (불변)', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '연도별 추세를 보여 주세요');
  const sv = F.saveRun(s, m.runId);
  assert.ok(sv.ok);
  assert.strictEqual(F.saveRun(s, m.runId).ok, false, '같은 결과 중복 저장 방지');
  const before = JSON.stringify(s.runs[m.runId]);
  s.candidates.forEach((c) => F.reviewCandidate(s, c.docId));
  assert.ok(F.publishBaseline(s).ok);
  assert.strictEqual(JSON.stringify(s.runs[m.runId]), before);
  assert.ok(Object.isFrozen(s.runs[m.runId]) && Object.isFrozen(s.runs[m.runId].rows[0]));
  assert.throws(() => { 'use strict'; s.runs[m.runId].rows[0].count = 999; });
  assert.strictEqual(s.runs[m.runId].totals.docs, 36);
  // 카드의 당시 결과도 그대로
  s.cards.forEach((c) => assert.strictEqual(s.runs[c.runIds[0]].baseline, 'V1'));
});

test('8. 재실행: 같은 조건을 최신 기준선에 적용하고 새 실행 번호 생성', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '연도별 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const sv = F.saveRun(s, m.runId).saved;
  s.candidates.forEach((c) => F.reviewCandidate(s, c.docId));
  F.publishBaseline(s);
  const r = F.rerunSaved(s, sv.id);
  assert.ok(r.ok);
  assert.notStrictEqual(r.run.id, m.runId);
  assert.strictEqual(r.run.baseline, 'V2');
  assert.deepStrictEqual(plain(r.run.spec), plain(s.runs[m.runId].spec));
  const kr2 = F.docsInBaseline(s, 'V2').filter((d) => d.country === 'KR');
  assert.strictEqual(r.run.totals.docs, kr2.length);
  assert.strictEqual(r.run.totals.docs, 27);
  const cmp = F.compareRuns(s.runs[m.runId], r.run);
  const y26 = cmp.find((x) => x.label === '2026년');
  assert.strictEqual(y26.before, null); assert.strictEqual(y26.after, 2);
  assert.strictEqual(s.comparisons.length, 1);
  // 카드 재계산: 새 버전 추가, 당시 결과 보존
  const card = s.cards.find((c) => c.id === 'CARD-02');
  const rc = F.rerunCard(s, 'CARD-02');
  assert.ok(rc.ok);
  assert.strictEqual(card.runIds.length, 2);
  const t2v1 = F.docsInBaseline(s, 'V1').filter((d) => d.sub === 'T2').length;
  const t2v2 = F.docsInBaseline(s, 'V2').filter((d) => d.sub === 'T2').length;
  assert.strictEqual(s.runs[card.runIds[0]].totals.docs, t2v1);
  assert.strictEqual(s.runs[card.runIds[1]].totals.docs, t2v2);
  assert.deepStrictEqual([t2v1, t2v2], [12, 17]);
  assert.strictEqual(F.rerunCard(s, 'CARD-02').ok, false, '같은 기준선 중복 재계산 방지');
});

test('9. 권리 질문은 자동 결론 없이 검토 요청으로, 중복 접수 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '쐐기 구조가 특허에 걸리나요?');
  assert.strictEqual(m.type, 'review');
  assert.strictEqual(m.layer, 'review');
  assert.ok(m.docIds.length > 0);
  m.docIds.forEach((id) => { const d = F.getDoc(id); assert.strictEqual(d.mech, '쐐기'); assert.strictEqual(d.rights, 'H'); });
  const r1 = F.requestReview(s, m.id);
  assert.ok(r1.ok);
  const m2 = F.ask(s, '쐐기 구조가 특허에 걸리나요');
  const r2 = F.requestReview(s, m2.id);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(s.requests.length, 1);
  assert.strictEqual(m2.requestId, r1.request.id);
});

test('10. 가상 답변 공개 → 연구자 채팅에 도착, 재공개 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '쐐기 구조가 특허에 걸리나요?');
  const req = F.requestReview(s, m.id).request;
  const p = F.publishAnswer(s, req.id);
  assert.ok(p.ok);
  assert.strictEqual(req.status, '답변 공개');
  assert.ok(req.answer.opinion.includes('가상 예시'));
  const last = s.chat[s.chat.length - 1];
  assert.strictEqual(last.type, 'reviewAnswer');
  assert.strictEqual(s.unreadAnswers, 1);
  assert.strictEqual(F.publishAnswer(s, req.id).ok, false);
  assert.strictEqual(s.chat.filter((x) => x.type === 'reviewAnswer').length, 1);
});

test('11. V2 공개: 모든 후보 검토 필요, 42건·21패밀리, 중복 공개 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  assert.strictEqual(F.publishBaseline(s).ok, false, '미검토 후보가 있으면 공개 불가');
  s.candidates.slice(0, 5).forEach((c) => F.reviewCandidate(s, c.docId));
  assert.strictEqual(F.publishBaseline(s).ok, false);
  F.reviewCandidate(s, s.candidates[5].docId);
  assert.strictEqual(F.reviewCandidate(s, s.candidates[5].docId).ok, false, '중복 검토 방지');
  assert.ok(F.publishBaseline(s).ok);
  const v2 = F.docsInBaseline(s, 'V2');
  assert.strictEqual(v2.length, 42);
  assert.strictEqual(fams(v2), 21);
  assert.strictEqual(s.currentBaseline, 'V2');
  assert.strictEqual(F.docsInBaseline(s, 'V1').length, 36, 'V1 보존');
  assert.strictEqual(F.publishBaseline(s).ok, false, '중복 공개 방지');
  assert.strictEqual(s.baselines.length, 2);
  const kinds = s.candidates.map((c) => c.kind);
  assert.strictEqual(kinds.filter((k) => k === '신규 패밀리').length, 4);
  assert.strictEqual(kinds.filter((k) => k === '기존 패밀리 추가').length, 2);
});

test('12. 과제 영향은 "확인 필요"에서 시작해 단계적으로만 진행', () => {
  const { F } = load();
  const s = F.createInitialState();
  s.candidates.forEach((c) => F.reviewCandidate(s, c.docId));
  F.publishBaseline(s);
  assert.ok(s.impacts.length >= 1);
  s.impacts.forEach((i) => assert.strictEqual(i.status, '확인 필요'));
  const t2 = s.impacts.find((i) => i.taskId === 'TASK-2');
  assert.ok(t2 && t2.docIds.includes('DEMO-KR-0026'));
  assert.ok(s.gapChanges.some((g) => g.cell === '흔들림 억제 × 자석'));
  const id = t2.id;
  assert.strictEqual(F.advanceImpact(s, id).impact.status, '검토 중');
  assert.strictEqual(F.advanceImpact(s, id).impact.status, '승인된 설명');
  assert.strictEqual(F.advanceImpact(s, id).ok, false);
  assert.ok(t2.note.includes('확정하지 않았으며'));
});

test('13. CSV: 같은 조건·기준선을 담고 셀을 안전하게 이스케이프', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '연도별 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const run = s.runs[m.runId];
  const csv = F.csvForRun(run);
  assert.ok(csv.includes(run.id) && csv.includes('V1'));
  assert.ok(csv.includes('국가: 국내(한국)만'));
  assert.ok(csv.includes('2025년,9'));
  const docLines = csv.split('\r\n').filter((l) => /^DEMO-/.test(l));
  assert.strictEqual(docLines.length, 24);
  assert.strictEqual(F.csvCell('a,b'), '"a,b"');
  assert.strictEqual(F.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(F.csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.strictEqual(F.csvCell('@cmd'), "'@cmd");
  assert.strictEqual(F.csvCell('줄\n바꿈'), '"줄\n바꿈"');
});

test('14. 입력 이스케이프와 과제 수정 검증', () => {
  const { F } = load();
  const s = F.createInitialState();
  assert.strictEqual(F.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(F.esc('"\'&'), '&quot;&#39;&amp;');
  const r = F.updateTask(s, 'TASK-1', { problem: '<script>x</script> 상판 1분 교체', constraints: 'a\n\n b ', decisionDate: 'not-a-date' });
  assert.ok(r.ok);
  const t = s.tasks[0];
  assert.strictEqual(t.editedBy, '연구자 수정');
  assert.deepStrictEqual(plain(t.constraints), ['a', 'b']);
  assert.strictEqual(t.decisionDate, '2026-11-30', '잘못된 날짜는 무시');
  assert.strictEqual(t.history.length, 1);
  assert.strictEqual(F.updateTask(s, 'TASK-1', { problem: '   ' }).ok, false);
  const m = F.ask(s, '<b>연도별</b> 추세');
  assert.strictEqual(s.chat[s.chat.length - 2].text, '<b>연도별</b> 추세'); // 원문은 보존, 화면에서 esc 처리
  assert.strictEqual(m.type, 'analysis');
});

test('15. 지원하지 않는 질문은 꾸며내지 않고 안내, DEMO ID 조회', () => {
  const { F } = load();
  const s = F.createInitialState();
  const runsBefore = s.runSeq;
  const u = F.ask(s, '오늘 점심 뭐 먹지?');
  assert.strictEqual(u.type, 'unsupported');
  assert.ok(u.supported.length >= 5);
  assert.strictEqual(s.runSeq, runsBefore, '지원하지 않는 질문은 계산을 만들지 않음');
  const d = F.ask(s, 'demo-kr-0001 보여줘');
  assert.strictEqual(d.type, 'doc');
  assert.strictEqual(d.docId, 'DEMO-KR-0001');
  assert.ok(d.found && d.inBaseline);
  assert.strictEqual(F.ask(s, 'DEMO-KR-9999').found, false);
  const g = F.ask(s, '공백 후보를 보여 주세요');
  const run = s.runs[g.runId];
  assert.strictEqual(run.matrix.cells['T2|자석'].count, 0);
  assert.strictEqual(run.matrix.cells['T3|탄성'].count, 0);
  assert.ok(F.describeRun(run).some((l) => l.includes('등록 가능성을 뜻하지 않습니다')));
  assert.strictEqual(F.ask(s, '   '), null);
});

test('16. 저장소: 저장 실패 처리, 손상된 상태 거부, 복원 후 불변 유지', () => {
  const { F } = load();
  const s = F.createInitialState();
  const blocked = { setItem() { throw new Error('QuotaExceeded'); }, getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.strictEqual(F.saveToStorage(blocked, s), false);
  assert.strictEqual(F.loadFromStorage(blocked), null);
  assert.strictEqual(F.clearStorage(blocked), false);
  const mem = {}; const store = { setItem(k, v) { mem[k] = v; }, getItem(k) { return mem[k] || null; }, removeItem(k) { delete mem[k]; } };
  const m = F.ask(s, '연도별 추세를 보여 주세요');
  assert.ok(F.saveToStorage(store, s));
  const back = F.loadFromStorage(store);
  assert.ok(back);
  assert.strictEqual(back.runs[m.runId].totals.docs, 36);
  assert.ok(Object.isFrozen(back.runs[m.runId]));
  mem[F.STORE_KEY] = '{broken';
  assert.strictEqual(F.loadFromStorage(store), null);
  mem[F.STORE_KEY] = JSON.stringify(Object.assign({}, s, { schema: 0 }));
  assert.strictEqual(F.loadFromStorage(store), null);
  const bad = JSON.parse(JSON.stringify(s)); bad.baselines[0].docIds.push('DEMO-XX-0000');
  mem[F.STORE_KEY] = JSON.stringify(bad);
  assert.strictEqual(F.loadFromStorage(store), null);
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('  ✓ ' + t.name); }
  catch (e) { console.log('  ✗ ' + t.name + '\n    ' + (e && e.message)); }
}
console.log('\n' + pass + ' / ' + tests.length + ' 통과');
process.exit(pass === tests.length ? 0 : 1);
