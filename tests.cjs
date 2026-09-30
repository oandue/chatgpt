// FDE 가상 데이터 시연 — 엔진 행동 검증 (의존성 없음)
// 실행: node tests.cjs
// index.html 안의 <script id="fde-data">, <script id="fde-core">를 그대로 꺼내 실행한다.
// 기대값은 되도록 엔진이 아닌 독립 계산으로 구하고, 기준 건수만 고정한다.
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

// ---------- 독립 계산 (엔진 함수를 쓰지 않음) ----------
function fams(docs) { return new Set(docs.map((d) => d.familyId)).size; }
const alive = (d) => d.status === '존속' || d.status === '공개·심사중';
function periodOf(y) { if (y <= 1979) return '~1979'; if (y >= 2025) return '2025–26'; const a = y - (y % 5); return a + '–' + String(a + 4).slice(2); }
function v1Docs(D) { return D.DOCS.filter((d) => d.stage === 'V1'); }
function publishAll(F, s) { s.candidates.forEach((c) => F.reviewCandidate(s, c.docId)); return F.publishBaseline(s); }

// 기준 건수 (데이터 생성기를 바꾸면 여기와 README 기준값 표를 함께 고친다)
const PIN = { v1: 212, v1Fam: 178, cand: 10, v2: 222, v2Fam: 186 };

test('1. 가상 데이터 기준 건수와 무결성', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const v1 = F.docsInBaseline(s, 'V1');
  assert.strictEqual(v1.length, PIN.v1);
  assert.strictEqual(fams(v1), PIN.v1Fam);
  assert.strictEqual(s.candidates.length, PIN.cand);
  const ids = D.DOCS.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'DEMO ID 중복');
  assert.ok(ids.every((id) => /^DEMO-(KR|US|JP|EP)-\d{4}$/.test(id)));
  assert.ok(D.DOCS.every((d) => d.applicant.endsWith('(가상)')), '가상 출원인 표기 누락');
  assert.ok(D.DOCS.every((d) => d.mechs.length >= 1 && d.mechs.every((m) => D.MECHS.includes(m))));
  assert.ok(D.DOCS.every((d) => D.STATUSES.includes(d.status) && D.CODES[d.code] && d.code[0] === d.sub));
  assert.strictEqual(D.TASKS.length, 4);
  assert.strictEqual(D.CARDS.length, 12);
  s.cards.forEach((c) => c.evidence.forEach((id) => assert.ok(s.baselines[0].docIds.includes(id), c.id + ' 근거 ' + id)));
  // 한국 가족특허 표시는 같은 패밀리에 KR 문헌이 있을 때만
  D.DOCS.forEach((d) => assert.strictEqual(d.krFamily, D.DOCS.some((x) => x.familyId === d.familyId && x.country === 'KR')));
});

test('2. 배열 집계가 독립 계산과 일치 (구간·제품군·국가·상태·결합방식)', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const v1 = v1Docs(D);
  const r = F.runAnalysis(s, { groupBy: 'period', unit: 'doc', filters: {} });
  r.rows.forEach((row) => assert.strictEqual(row.count, v1.filter((d) => periodOf(d.year) === row.key).length, row.key));
  assert.strictEqual(r.rowSum, PIN.v1);
  [['sub', 'sub'], ['country', 'country'], ['status', 'status']].forEach(([g, f]) => {
    const rr = F.runAnalysis(s, { groupBy: g, unit: 'doc', filters: {} });
    rr.rows.forEach((row) => assert.strictEqual(row.count, v1.filter((d) => d[f] === row.key).length, g + ' ' + row.key));
    assert.strictEqual(rr.rowSum, PIN.v1);
  });
  const m = F.runAnalysis(s, { groupBy: 'mech', unit: 'doc', filters: {} });
  m.rows.forEach((row) => assert.strictEqual(row.count, v1.filter((d) => d.mechs.includes(row.key)).length));
  assert.strictEqual(m.rowSum, v1.reduce((a, d) => a + d.mechs.length, 0), '결합방식 합계는 중복 포함');
  assert.ok(m.rowSum > PIN.v1);
});

test('3. 후보 영역은 승인 전 집계·검색·질문에 섞이지 않음', () => {
  const { F } = load();
  const s = F.createInitialState();
  const candIds = s.candidates.map((c) => c.docId);
  F.ask(s, '출원 추세를 보여 주세요');
  const run = s.runs[s.ctx.runId];
  assert.strictEqual(run.totals.docs, PIN.v1);
  assert.ok(!run.docIds.some((id) => candIds.includes(id)));
  const found = F.searchAll(s, '오버센터 레버', {});
  assert.ok(!found.docs.some((d) => candIds.includes(d.id)));
  const m = F.ask(s, candIds[0]);
  assert.strictEqual(m.inBaseline, false);
  assert.ok(!F.riskRows(s).some((r) => candIds.includes(r.docId)));
});

test('4. 후속 질문: "그중 국내만"이 추세 보기를 유지하고 국가 조건을 추가', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  F.ask(s, '출원 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const run = s.runs[m.runId];
  const kr = v1Docs(D).filter((d) => d.country === 'KR');
  assert.strictEqual(run.spec.groupBy, 'period');
  assert.strictEqual(run.spec.filters.country, 'KR');
  assert.strictEqual(run.totals.docs, kr.length);
  assert.deepStrictEqual(plain(m.changes.added), ['국가: 국내(한국)만']);
  run.rows.forEach((r) => assert.strictEqual(r.count, kr.filter((d) => periodOf(d.year) === r.key).length));
});

test('5. 패밀리 단위: 중복 제거, 항목 합과 전체 고유 수를 구분', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  F.ask(s, '결합방식별로 보여 주세요');
  const m = F.ask(s, '패밀리 단위로 보여 주세요');
  const run = s.runs[m.runId];
  const v1 = v1Docs(D);
  assert.strictEqual(run.spec.unit, 'family');
  assert.strictEqual(run.spec.groupBy, 'mech', '보기 유지');
  assert.strictEqual(run.totals.families, fams(v1));
  run.rows.forEach((r) => assert.strictEqual(r.count, fams(v1.filter((d) => d.mechs.includes(r.key)))));
  assert.ok(fams(v1) < v1.length, '패밀리가 문헌보다 적어야 함');
  const p = F.runAnalysis(s, { groupBy: 'period', unit: 'family', filters: {} });
  assert.strictEqual(p.totals.families, PIN.v1Fam);
});

test('6. 검색 범위 유지와 새 주제의 조건 변경 표시', () => {
  const { F } = load();
  const s = F.createInitialState();
  const a = F.ask(s, '의자 관련 결합방식은?');
  assert.strictEqual(s.runs[a.runId].spec.filters.sub, 'B');
  const b = F.ask(s, '그중 국내만');
  assert.strictEqual(s.runs[b.runId].spec.filters.sub, 'B', '제품군 범위 유지');
  assert.ok(b.changes.kept.includes('제품군: B 성장형 의자'));
  const c = F.ask(s, '그중 자석만');
  assert.strictEqual(s.runs[c.runId].spec.filters.mech, '자석');
  const t = F.ask(s, '공백 후보를 보여 주세요');
  assert.ok(t.changes.newTopic);
  assert.ok(t.changes.removed.includes('국가: 국내(한국)만') && t.changes.removed.includes('제품군: B 성장형 의자'));
  assert.strictEqual(s.runs[t.runId].spec.filters.status, 'alive');
  F.ask(s, '조건 초기화');
  assert.strictEqual(s.ctx, null);
});

test('7. 저장 결과는 V2 공개 후에도 바뀌지 않음 (불변)', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '출원 추세를 보여 주세요');
  assert.ok(F.saveRun(s, m.runId).ok);
  assert.strictEqual(F.saveRun(s, m.runId).ok, false, '같은 결과 중복 저장 방지');
  const before = JSON.stringify(s.runs[m.runId]);
  assert.ok(publishAll(F, s).ok);
  assert.strictEqual(JSON.stringify(s.runs[m.runId]), before);
  assert.ok(Object.isFrozen(s.runs[m.runId]) && Object.isFrozen(s.runs[m.runId].rows[0]));
  assert.throws(() => { 'use strict'; s.runs[m.runId].rows[0].count = 999; });
  s.cards.forEach((c) => assert.strictEqual(s.runs[c.runIds[0]].baseline, 'V1'));
});

test('8. 재실행: 같은 조건을 최신 기준선에 적용하고 새 실행 번호 생성', () => {
  const { F } = load();
  const s = F.createInitialState();
  F.ask(s, '출원 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const sv = F.saveRun(s, m.runId).saved;
  publishAll(F, s);
  const r = F.rerunSaved(s, sv.id);
  assert.ok(r.ok);
  assert.notStrictEqual(r.run.id, m.runId);
  assert.strictEqual(r.run.baseline, 'V2');
  assert.deepStrictEqual(plain(r.run.spec), plain(s.runs[m.runId].spec));
  assert.strictEqual(r.run.totals.docs, F.docsInBaseline(s, 'V2').filter((d) => d.country === 'KR').length);
  assert.ok(r.run.totals.docs > s.runs[m.runId].totals.docs);
  const cmp = F.compareRuns(s.runs[m.runId], r.run);
  assert.ok(cmp.some((x) => x.diff > 0));
  assert.strictEqual(s.comparisons.length, 1);
  const card = s.cards.find((c) => c.id === 'CARD-03');
  assert.ok(F.rerunCard(s, 'CARD-03').ok);
  assert.strictEqual(card.runIds.length, 2);
  assert.strictEqual(s.runs[card.runIds[0]].totals.docs, F.docsInBaseline(s, 'V1').filter((d) => d.rel === 'Core').length);
  assert.strictEqual(s.runs[card.runIds[1]].totals.docs, F.docsInBaseline(s, 'V2').filter((d) => d.rel === 'Core').length);
  assert.strictEqual(F.rerunCard(s, 'CARD-03').ok, false, '같은 기준선 중복 재계산 방지');
});

test('9. 권리 질문은 자동 결론 없이 검토 요청으로, 중복 접수 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '레버 클램프가 특허에 걸리나요?');
  assert.strictEqual(m.type, 'review');
  assert.ok(m.docIds.length > 0);
  m.docIds.forEach((id) => { const d = F.getDoc(id); assert.ok(d.mechs.includes('클램프·쐐기') && d.rights === 'H' && alive(d)); });
  assert.ok(F.requestReview(s, m.id).ok);
  const m2 = F.ask(s, '레버 클램프가 특허에 걸리나요');
  assert.strictEqual(F.requestReview(s, m2.id).ok, false);
  assert.strictEqual(s.requests.length, 1);
  // 국내 핵심 특허 목록 질문도 결론 없이 '검토 필요' 층으로
  const k = F.ask(s, '국내 핵심 특허를 보여 주세요');
  assert.strictEqual(k.layer, 'review');
});

test('10. 가상 답변 공개 → 연구자 채팅에 도착, 재공개 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '레버 클램프가 특허에 걸리나요?');
  const req = F.requestReview(s, m.id).request;
  assert.ok(F.publishAnswer(s, req.id).ok);
  assert.strictEqual(req.status, '답변 공개');
  assert.ok(req.answer.opinion.includes('가상 예시'));
  assert.strictEqual(s.chat[s.chat.length - 1].type, 'reviewAnswer');
  assert.strictEqual(s.unreadAnswers, 1);
  assert.strictEqual(F.publishAnswer(s, req.id).ok, false);
});

test('11. V2 공개: 모든 후보 검토 필요, 기준 건수, 중복 공개 방지', () => {
  const { F } = load();
  const s = F.createInitialState();
  assert.strictEqual(F.publishBaseline(s).ok, false);
  s.candidates.slice(0, -1).forEach((c) => F.reviewCandidate(s, c.docId));
  assert.strictEqual(F.publishBaseline(s).ok, false);
  const last = s.candidates[s.candidates.length - 1].docId;
  F.reviewCandidate(s, last);
  assert.strictEqual(F.reviewCandidate(s, last).ok, false, '중복 검토 방지');
  assert.ok(F.publishBaseline(s).ok);
  const v2 = F.docsInBaseline(s, 'V2');
  assert.strictEqual(v2.length, PIN.v2);
  assert.strictEqual(fams(v2), PIN.v2Fam);
  assert.strictEqual(F.docsInBaseline(s, 'V1').length, PIN.v1, 'V1 보존');
  assert.strictEqual(F.publishBaseline(s).ok, false);
  const kinds = s.candidates.map((c) => c.kind);
  assert.strictEqual(kinds.filter((k) => k === '기존 패밀리 추가').length, PIN.cand - (PIN.v2Fam - PIN.v1Fam));
});

test('12. 과제 영향은 "확인 필요"에서 시작, 공백 변화 표시, 단계적 진행', () => {
  const { F } = load();
  const s = F.createInitialState();
  publishAll(F, s);
  assert.ok(s.impacts.length >= 1);
  s.impacts.forEach((i) => assert.strictEqual(i.status, '확인 필요'));
  const c = s.impacts.find((i) => i.taskId === 'TASK-C');
  assert.ok(c && c.docIds.some((id) => F.getDoc(id).title.includes('오버센터 레버')));
  assert.ok(s.gapChanges.some((g) => g.cell === '회전·캠 × 성장형 의자'));
  assert.strictEqual(F.advanceImpact(s, c.id).impact.status, '검토 중');
  assert.strictEqual(F.advanceImpact(s, c.id).impact.status, '승인된 설명');
  assert.strictEqual(F.advanceImpact(s, c.id).ok, false);
  assert.ok(c.note.includes('확정하지 않았으며'));
});

test('13. CSV: 같은 조건·기준선을 담고 셀을 안전하게 이스케이프', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  F.ask(s, '출원 추세를 보여 주세요');
  const m = F.ask(s, '그중 국내만');
  const run = s.runs[m.runId];
  const csv = F.csvForRun(run);
  assert.ok(csv.includes(run.id) && csv.includes('V1') && csv.includes('국가: 국내(한국)만'));
  assert.strictEqual(csv.split('\r\n').filter((l) => /^DEMO-/.test(l)).length, v1Docs(D).filter((d) => d.country === 'KR').length);
  const share = F.csvForRun(F.runAnalysis(s, { groupBy: 'share', unit: 'doc', filters: {} }));
  assert.ok(share.includes('형상맞물림(%)'));
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
  const r = F.updateTask(s, 'TASK-C', { problem: '<script>x</script> 무타공 다리', constraints: 'a\n\n b ', decisionDate: 'not-a-date' });
  assert.ok(r.ok);
  const t = s.tasks.find((x) => x.id === 'TASK-C');
  assert.strictEqual(t.editedBy, '연구자 수정');
  assert.deepStrictEqual(plain(t.constraints), ['a', 'b']);
  assert.strictEqual(t.decisionDate, '2026-11-30', '잘못된 날짜는 무시');
  assert.strictEqual(F.updateTask(s, 'TASK-C', { problem: '   ' }).ok, false);
});

test('15. 지원하지 않는 질문은 꾸며내지 않고 안내, DEMO ID 조회, 공백 주의 문구', () => {
  const { F } = load();
  const s = F.createInitialState();
  const before = s.runSeq;
  const u = F.ask(s, '오늘 점심 뭐 먹지?');
  assert.strictEqual(u.type, 'unsupported');
  assert.strictEqual(s.runSeq, before, '지원하지 않는 질문은 계산을 만들지 않음');
  const d = F.ask(s, 'demo-kr-0001 보여줘');
  assert.strictEqual(d.docId, 'DEMO-KR-0001');
  assert.ok(d.found && d.inBaseline);
  assert.strictEqual(F.ask(s, 'DEMO-KR-9999').found, false);
  const g = F.ask(s, '공백 후보를 보여 주세요');
  const run = s.runs[g.runId];
  assert.strictEqual(run.matrix.cells['회전·캠|B'].count, 0);
  assert.ok(F.describeRun(run).some((l) => l.includes('등록 가능성을 뜻하지 않습니다')));
  assert.strictEqual(F.ask(s, 'IP 개선안을 보여 주세요').type, 'ip');
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
  const m = F.ask(s, '출원 추세를 보여 주세요');
  assert.ok(F.saveToStorage(store, s));
  const back = F.loadFromStorage(store);
  assert.strictEqual(back.runs[m.runId].totals.docs, PIN.v1);
  assert.ok(Object.isFrozen(back.runs[m.runId]));
  mem[F.STORE_KEY] = '{broken';
  assert.strictEqual(F.loadFromStorage(store), null);
  mem[F.STORE_KEY] = JSON.stringify(Object.assign({}, s, { schema: 3 }));
  assert.strictEqual(F.loadFromStorage(store), null, '이전 스키마 거부');
  const bad = JSON.parse(JSON.stringify(s)); bad.baselines[0].docIds.push('DEMO-XX-0000');
  mem[F.STORE_KEY] = JSON.stringify(bad);
  assert.strictEqual(F.loadFromStorage(store), null);
});

test('17. 해외 특허의 국내 영향: 단계별 수치가 독립 계산과 일치', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const m = F.ask(s, '해외 특허가 국내 사업에 영향을 주나요?');
  const run = s.runs[m.runId];
  assert.strictEqual(run.spec.groupBy, 'funnel');
  assert.ok(!run.spec.filters.country, '"국내"라는 말이 국가 필터로 잘못 붙지 않음');
  const f1 = v1Docs(D).filter((d) => d.country !== 'KR'), f2 = f1.filter(alive), f3 = f2.filter((d) => d.krFamily);
  assert.deepStrictEqual(plain(run.rows.map((r) => r.count)), [f1.length, f2.length, f3.length]);
  assert.ok(f3.length < f2.length);
});

test('18. 결합방식 비중 추세와 만료 캘린더가 독립 계산과 일치', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const v1 = v1Docs(D);
  const sh = F.runAnalysis(s, { groupBy: 'share', unit: 'doc', filters: {} });
  const eras = [[0, 1999], [2000, 2009], [2010, 2019], [2020, 2026]];
  eras.forEach(([a, b], i) => {
    const ds = v1.filter((d) => d.year >= a && d.year <= b);
    assert.strictEqual(sh.rows[i].count, ds.length);
    assert.strictEqual(sh.series['자석'][i], Math.round(ds.filter((d) => d.mechs.includes('자석')).length * 100 / ds.length));
  });
  const m = F.ask(s, '만료 예정 캘린더');
  const run = s.runs[m.runId];
  const krAlive = v1.filter((d) => d.country === 'KR' && alive(d));
  assert.strictEqual(run.totals.docs, krAlive.length);
  run.rows.forEach((r) => assert.strictEqual(r.count, krAlive.filter((d) => d.expiryYear === r.key).length));
});

test('19. 국내 핵심 특허 대조표: 예비 분류 규칙, 공개 전 비공개, 중복 공개 방지 / 발명 후보 단계', () => {
  const { F } = load();
  const s = F.createInitialState();
  assert.strictEqual(F.riskPrelim([['a', '해당', true], ['b', '해당', false]]), '상');
  assert.strictEqual(F.riskPrelim([['a', '해당', true], ['b', '비해당', true]]), '하');
  assert.strictEqual(F.riskPrelim([['a', '해당', true], ['b', '검토', true], ['c', '비해당', false]]), '중');
  const rows = F.riskRows(s);
  assert.ok(rows.length >= 5);
  rows.forEach((r) => { const d = F.getDoc(r.docId); assert.ok(d.country === 'KR' && d.rel === 'Core' && alive(d)); assert.strictEqual(r.status, '검토 대기'); });
  assert.ok(new Set(rows.map((r) => r.prelim)).size === 3, '상·중·하가 모두 있어야 함');
  assert.ok(F.publishRisk(s, rows[0].docId).ok);
  assert.strictEqual(F.publishRisk(s, rows[0].docId).ok, false);
  assert.strictEqual(F.riskRows(s)[0].status, '의견 공개');
  const ic = s.ipCandidates[0];
  const flow = F.IC_FLOW;
  while (ic.status !== flow[flow.length - 1]) assert.ok(F.advanceCandidate(s, ic.id).ok);
  assert.strictEqual(F.advanceCandidate(s, ic.id).ok, false);
});

test('20. 시사점 수치는 요약 계산과 독립 계산이 일치하고 기준선을 따라 바뀜', () => {
  const { D, F } = load();
  const s = F.createInitialState();
  const v1 = v1Docs(D);
  const st = F.projectStats(s);
  assert.strictEqual(st.expired, v1.filter((d) => d.status === '만료 추정').length);
  assert.strictEqual(st.krCoreAlive, v1.filter((d) => d.country === 'KR' && d.rel === 'Core' && alive(d)).length);
  assert.strictEqual(st.coreBy.A + st.coreBy.B, 0, 'A·B 제품군 Core 0건');
  const ins = F.insights(s);
  assert.strictEqual(ins.length, 6);
  assert.strictEqual(ins[1].big, st.expiredPct + '%');
  publishAll(F, s);
  assert.strictEqual(F.projectStats(s).docs, PIN.v2);
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('  ✓ ' + t.name); }
  catch (e) { console.log('  ✗ ' + t.name + '\n    ' + (e && e.message)); }
}
console.log('\n' + pass + ' / ' + tests.length + ' 통과');
process.exit(pass === tests.length ? 0 : 1);
