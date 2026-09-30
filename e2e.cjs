// FDE 가상 데이터 시연 — 실제 브라우저(Chromium) 7단계 리허설
// 실행: node e2e.cjs   (playwright 필요. 전역 설치라면 NODE_PATH="$(npm root -g)" node e2e.cjs)
// 스크린샷은 screenshots/ 에 저장한다.
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('playwright를 찾지 못해 브라우저 검증을 건너뜁니다. (npm i -D playwright 또는 NODE_PATH 설정)');
  process.exit(2);
}

const FILE = 'file://' + path.join(__dirname, 'index.html');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ✓ ' + name); }
  catch (e) { results.push([false, name]); console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

(async () => {
  const launch = {};
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const S = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__FDE_UI.getState())));
  const ask = async (q) => { await page.fill('#ask-input', q); await page.click('#ask-form button[type=submit]'); };
  const lastBot = () => page.locator('#thread .msg-bot').last();

  await page.goto(FILE);
  await page.click('[data-act=reset]');

  await step('초기 화면: 기준선 V1 36건 표시, 메뉴 7개', async () => {
    assert.match(await page.textContent('#baseline-badge'), /V1.*36건/);
    assert.strictEqual(await page.locator('nav.side button').count(), 7);
  });

  await step('메뉴: 모든 화면이 오류 없이 열림', async () => {
    for (const v of ['today', 'ask', 'browse', 'tasks', 'updates', 'saved', 'workbench']) {
      await page.click(`nav.side [data-id=${v}]`);
      assert.strictEqual(await page.getAttribute(`nav.side [data-id=${v}]`, 'aria-current'), 'page');
    }
  });

  await step('시연 가이드: 열기·다음·단계 화면 열기', async () => {
    await page.click('[data-act=guide-open]');
    await page.waitForSelector('.guide');
    await page.click('[data-act=guide-next]');
    assert.match(await page.textContent('.guide h3'), /2\. 질문/);
    await page.click('[data-act=guide-go]');
    assert.strictEqual(await page.inputValue('#ask-input'), '연도별 추세를 보여 주세요');
    await page.click('[data-act=guide-close]');
  });

  await step('1 발견: 과제 선택과 질문형 카드 열기', async () => {
    await page.click('nav.side [data-id=today]');
    await page.click('[data-act=task-select][data-id=TASK-2]');
    await page.click('.card-item[data-id=CARD-02]');
    await page.waitForSelector('#drawer');
    const t = await page.textContent('#drawer');
    assert.ok(t.includes('흔들림을 줄이는') && t.includes('p.45') && t.includes('기준선 V1'));
    await page.screenshot({ path: path.join(SHOTS, '1_card.png') });
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('#drawer').count(), 0);
  });

  await step('2 질문·추세: 연도별 36건 그래프', async () => {
    await page.click('nav.side [data-id=ask]');
    await ask('연도별 추세를 보여 주세요');
    const b = lastBot();
    assert.ok((await b.textContent()).includes('문헌 36건'));
    assert.strictEqual(await b.locator('svg.chart rect').count(), 6);
    const vals = await b.locator('tbody td.num').allTextContents();
    assert.deepStrictEqual(vals, ['3', '4', '5', '6', '8', '10']);
  });

  await step('3 후속 조건: 국내만 24건 → 패밀리 단위 14개', async () => {
    await ask('그중 국내만');
    let t = await lastBot().textContent();
    assert.ok(t.includes('문헌 24건') && t.includes('추가: 국가: 국내(한국)만'));
    await ask('패밀리 단위로 보여 주세요');
    t = await lastBot().textContent();
    assert.ok(t.includes('고유 패밀리 14개') && t.includes('유지: 국가: 국내(한국)만'));
    assert.ok(t.includes('합(') && t.includes('다릅니다'));
    assert.ok((await page.textContent('.condbar')).includes('패밀리'));
    const navBox = await page.evaluate(() => document.querySelector('nav.side').getBoundingClientRect().top);
    assert.ok(navBox >= 0 && navBox < 150, '스크롤 후에도 메뉴가 보여야 함: ' + navBox);
    await page.screenshot({ path: path.join(SHOTS, '3_followup.png'), fullPage: false });
  });

  let savedRunId;
  await step('4 근거·저장·CSV: 원문 열기, 저장, CSV 내려받기', async () => {
    const b = lastBot();
    savedRunId = await b.getAttribute('data-run');
    await b.locator('.doc-chip').first().click();
    const dt = await page.textContent('#drawer');
    assert.ok(dt.includes('가상 원문') && dt.includes('청구항 1') && dt.includes('세 축 등급'));
    await page.click('#drawer [data-act=close-drawer]');
    await lastBot().locator('[data-act=save]').click();
    assert.ok((await lastBot().textContent()).includes('저장됨 SAVE-001'));
    const [dl] = await Promise.all([page.waitForEvent('download'), lastBot().locator('[data-act=csv]').click()]);
    const p = await dl.path();
    const csv = fs.readFileSync(p, 'utf8');
    assert.ok(dl.suggestedFilename().includes(savedRunId));
    assert.ok(csv.includes('국가: 국내(한국)만') && csv.includes('패밀리 수'));
    fs.copyFileSync(p, path.join(SHOTS, dl.suggestedFilename()));
  });

  await step('5 전문 검토: 요청 → FDE 가상 답변 공개 → 연구자 도착 확인', async () => {
    await ask('쐐기 구조가 특허에 걸리나요?');
    assert.ok((await lastBot().textContent()).includes('자동으로 결론을 내지 않습니다'));
    await lastBot().locator('[data-act=request]').click();
    assert.ok((await lastBot().textContent()).includes('REQ-001 검토 요청됨'));
    await ask('쐐기 구조가 특허에 걸리나요?');
    await lastBot().locator('[data-act=request]').click();
    assert.strictEqual((await S()).requests.length, 1, '중복 요청 접수됨');
    await page.click('.role-switch [data-id=fde]');
    await page.click('nav.side [data-id=workbench]');
    await page.click('[data-act=publish-answer][data-id=REQ-001]');
    assert.ok((await page.textContent('main')).includes('가상 답변을 공개했습니다'));
    await page.click('.role-switch [data-id=researcher]');
    assert.strictEqual(await page.textContent('nav.side [data-id=ask] .count'), '1');
    await page.click('nav.side [data-id=ask]');
    assert.strictEqual(await page.locator('nav.side [data-id=ask] .count').count(), 0, '읽은 뒤 배지가 남음');
    assert.ok(await page.locator('#thread .msg-bot').last().isVisible());
    const t = await page.locator('#thread .msg-bot').last().textContent();
    assert.ok(t.includes('공개된 가상 검토 답변 예시') && t.includes('실제 변리사 의견이 아니며'));
    await page.screenshot({ path: path.join(SHOTS, '5_review.png') });
  });

  await step('6 갱신: 후보 6건 검토 → V2 공개 42건, 과제 영향 확인 필요', async () => {
    await page.click('.role-switch [data-id=fde]');
    await page.click('nav.side [data-id=workbench]');
    assert.ok(await page.locator('[data-act=publish-v2]').isDisabled());
    await page.click('[data-act=review-all]');
    await page.click('[data-act=publish-v2]');
    assert.match(await page.textContent('#baseline-badge'), /V2.*42건/);
    await page.click('nav.side [data-id=updates]');
    const t = await page.textContent('main');
    assert.ok(t.includes('36 → 42') && t.includes('18 → 21') && t.includes('확인 필요'));
    assert.ok(t.includes('흔들림 억제 × 자석'));
    await page.screenshot({ path: path.join(SHOTS, '6_update.png'), fullPage: true });
    await page.click('nav.side [data-id=workbench]');
    const first = page.locator('[data-act=advance-impact]').first();
    await first.click();
    await page.locator('[data-act=advance-impact]').first().click();
    assert.ok((await page.textContent('main')).includes('승인된 설명'));
  });

  await step('7 과거·최신 비교: 저장 결과 보존, 재실행 새 ID, 나란히 비교', async () => {
    await page.click('.role-switch [data-id=researcher]');
    await page.click('nav.side [data-id=saved]');
    const panel = page.locator('[data-saved=SAVE-001]');
    let t = await panel.textContent();
    assert.ok(t.includes('기준선 V1') && t.includes(savedRunId));
    const before = (await S()).runs[savedRunId];
    await panel.locator('[data-act=rerun]').click();
    const st = await S();
    const cmp = st.comparisons[0];
    assert.strictEqual(cmp.baseRunId, savedRunId);
    assert.notStrictEqual(cmp.newRunId, savedRunId);
    assert.deepStrictEqual(st.runs[savedRunId], before, '저장 결과가 바뀜');
    t = await page.locator('[data-saved=SAVE-001]').textContent();
    assert.ok(t.includes('동일 조건') && t.includes(cmp.newRunId + ' · V2') && t.includes('2026년'));
    await page.screenshot({ path: path.join(SHOTS, '7_compare.png'), fullPage: true });
  });

  await step('카드 재계산: 당시 결과 보존 + 새 버전', async () => {
    await page.click('nav.side [data-id=browse]');
    await page.click('.card-item[data-id=CARD-02]');
    await page.click('#drawer [data-act=rerun-card]');
    const t = await page.textContent('#drawer');
    assert.ok(t.includes('당시 결과') && t.includes('재계산 1'));
    await page.click('#drawer [data-act=close-drawer]');
  });

  await step('찾아보기: 용어사전 확장 표시, 0건 안내', async () => {
    await page.fill('#browse-q', '진동');
    const t = await page.textContent('#browse-results');
    assert.ok(t.includes('넓혀 찾은 말') && t.includes('흔들림'));
    await page.fill('#browse-q', '전기자동차');
    assert.ok((await page.textContent('#browse-results')).includes('범위 밖일 수 있습니다'));
  });

  await step('과제 수정: HTML 입력이 실행되지 않고 문자로 표시', async () => {
    await page.click('nav.side [data-id=tasks]');
    await page.click('[data-act=task-edit][data-id=TASK-1]');
    await page.fill('#p-TASK-1', '<img src=x onerror="window.__xss=1"> 1분 교체');
    await page.click('[data-form=task] button[type=submit]');
    const t = await page.textContent('#task-TASK-1');
    assert.ok(t.includes('<img src=x') && t.includes('연구자 수정'));
    assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
    assert.strictEqual(await page.locator('#task-TASK-1 img').count(), 0);
  });

  await step('새로고침 후 상태 유지 (V2, 저장 결과)', async () => {
    await page.reload();
    assert.match(await page.textContent('#baseline-badge'), /V2/);
    const st = await S();
    assert.strictEqual(st.saved.length, 1);
    assert.strictEqual(st.runs[savedRunId].baseline, 'V1');
  });

  await step('초기화: 처음 상태로 복귀', async () => {
    await page.click('[data-act=reset]');
    assert.match(await page.textContent('#baseline-badge'), /V1.*36건/);
    const st = await S();
    assert.strictEqual(st.saved.length + st.requests.length + st.chat.length, 0);
  });

  await step('모바일 폭(390px): 가로 스크롤 없음, 메뉴 사용 가능', async () => {
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    m.on('pageerror', (e) => errors.push(String(e)));
    await m.goto(FILE);
    await m.click('nav.side [data-id=ask]');
    await m.fill('#ask-input', '연도별 추세를 보여 주세요');
    await m.click('#ask-form button[type=submit]');
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, '가로 넘침 ' + overflow + 'px');
    await m.evaluate(() => window.scrollTo(0, 400));
    assert.ok(await m.locator('nav.side').isVisible(), '스크롤 후 메뉴가 보여야 함');
    const navTop = await m.evaluate(() => document.querySelector('nav.side').getBoundingClientRect().top);
    assert.ok(Math.abs(navTop) <= 1, '메뉴가 상단에 고정되어야 함: ' + navTop);
    await m.screenshot({ path: path.join(SHOTS, 'mobile_ask.png') });
    await m.close();
  });

  await step('키보드: Tab으로 메뉴 이동 후 Enter로 화면 전환', async () => {
    const k = await browser.newPage();
    await k.goto(FILE);
    await k.focus('nav.side [data-id=today]');
    await k.keyboard.press('Tab');
    await k.keyboard.press('Enter');
    assert.strictEqual(await k.getAttribute('nav.side [data-id=ask]', 'aria-current'), 'page');
    await k.close();
  });

  await step('브라우저 저장 차단 시에도 동작하고 경고 표시', async () => {
    const b = await browser.newPage();
    await b.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
    });
    await b.goto(FILE);
    assert.ok((await b.textContent('.demo-banner')).includes('저장이 차단'));
    await b.click('nav.side [data-id=ask]');
    await b.fill('#ask-input', '연도별 추세를 보여 주세요');
    await b.click('#ask-form button[type=submit]');
    assert.ok((await b.locator('#thread .msg-bot').last().textContent()).includes('36건'));
    await b.close();
  });

  await step('콘솔 오류 없음', async () => { assert.deepStrictEqual(errors, []); });

  await browser.close();
  const ok = results.filter((r) => r[0]).length;
  console.log('\n' + ok + ' / ' + results.length + ' 통과 (스크린샷: screenshots/)');
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
