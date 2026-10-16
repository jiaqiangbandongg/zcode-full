/* oxlint-disable -- recorded production script, kept verbatim as a smoke fixture */
// Smoke corpus (tests/smoke.test.ts). Source: a recorded production run, dwf_run
// dwfrun-dd690b62-7905-4de6-8d15-7fb090503824 (2026-08-20). Xiangqi rules engine + two player
// agents: ~25 pure helpers inlined ~400 times, 2,500 trace regions, 1,900 of them leafless.
// Broke projectControlFlow (RangeError after 12 s) until 2026-09-03; see
// docs/analysis.md, "The control-flow graph".

// ============================================================
//  中国象棋 (Xiangqi) 双 Agent 对弈 Workflow
//  红方「赤霄」(攻击型) vs 黑方「玄弈」(稳健型)
//  完整规则内嵌: 蹩马腿/塞象眼/九宫/炮打隔子/将帅照面/绝杀/困毙/判和
//  坐标: 行 r 0(黑底线/顶)~9(红底线/底), 列 c 0~8 (左->右)
// ============================================================

type Side = 'red' | 'black';

interface Move { fr: number; fc: number; tr: number; tc: number }
interface MoveDecision { move: string; thought: string }
interface HistoryEntry { n: number; side: Side; piece: string; from: string; to: string; captured: string | null; thought: string }
interface GameResult {
  winner: Side | 'draw';
  reason: string;
  plies: number;
  finalBoard: string;
  history: HistoryEntry[];
  redThoughts: string[];
  blackThoughts: string[];
}

const RED: Side = 'red';
const BLACK: Side = 'black';
const PLY_CAP = 60;          // 手数上限, 超出按物质判定
const NO_CAPTURE_DRAW = 40;  // 连续无吃子手数判和
const ADJUDICATE_MARGIN = 4; // 物质判定阈值
const VAL: Record<string, number> = { K: 0, A: 2, E: 2, H: 4, R: 9, C: 4.5, P: 1 };
const CN: Record<string, string> = {
  K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', e: '象', h: '马', r: '车', c: '炮', p: '卒',
};
const val = (p: string): number => VAL[p]!;
const cn = (p: string): string => CN[p]!;
const opp = (s: Side): Side => (s === RED ? BLACK : RED);
const sideOf = (p: string): Side | null => (p === '.' ? null : p === p.toUpperCase() ? RED : BLACK);
const typeOf = (p: string): string => p.toUpperCase();
const inSquare = (r: number, c: number): boolean => r >= 0 && r <= 9 && c >= 0 && c <= 8;
const inPalace = (r: number, c: number, s: Side): boolean => c >= 3 && c <= 5 && (s === RED ? r >= 7 : r <= 2);
// 盘面读写助手
const at = (b: string[][], r: number, c: number): string => b[r]![c]!;
const put = (b: string[][], r: number, c: number, p: string): void => { b[r]![c] = p; };

// ---------------- 盘面 ----------------
function initialBoard(): string[][] {
  const b: string[][] = Array.from({ length: 10 }, () => Array<string>(9).fill('.'));
  const back = ['r', 'h', 'e', 'a', 'k', 'a', 'e', 'h', 'r'];
  for (let c = 0; c < 9; c++) { put(b, 0, c, back[c]!); put(b, 9, c, back[c]!.toUpperCase()); }
  put(b, 2, 1, 'c'); put(b, 2, 7, 'c'); put(b, 7, 1, 'C'); put(b, 7, 7, 'C');
  for (let c = 0; c < 9; c += 2) { put(b, 3, c, 'p'); put(b, 6, c, 'P'); }
  return b;
}
const cloneBoard = (b: string[][]): string[][] => b.map(row => row.slice());

function pseudoMoves(b: string[][], side: Side): Move[] {
  const ms: Move[] = [];
  const push = (fr: number, fc: number, tr: number, tc: number): void => {
    if (!inSquare(tr, tc)) return;
    const t = at(b, tr, tc);
    if (t === '.' || sideOf(t) !== side) ms.push({ fr, fc, tr, tc });
  };
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = at(b, r, c);
    if (p === '.' || sideOf(p) !== side) continue;
    switch (typeOf(p)) {
      case 'K': { // 帅/将: 九宫内横直一步
        const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dr, dc] of dirs) if (inPalace(r + dr, c + dc, side)) push(r, c, r + dr, c + dc);
        break;
      }
      case 'A': { // 仕/士: 九宫内斜一步
        const dirs: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (const [dr, dc] of dirs) if (inPalace(r + dr, c + dc, side)) push(r, c, r + dr, c + dc);
        break;
      }
      case 'E': { // 相/象: 田字, 不过河, 塞象眼不可走
        const dirs: [number, number][] = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
        for (const [dr, dc] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (!inSquare(nr, nc)) continue;
          if (side === RED && nr < 5) continue;
          if (side === BLACK && nr > 4) continue;
          if (at(b, r + dr / 2, c + dc / 2) !== '.') continue;
          push(r, c, nr, nc);
        }
        break;
      }
      case 'H': { // 马: 日字, 蹩马腿不可走
        const legs: [number, number, number, number][] = [
          [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
          [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
        ];
        for (const [dr, dc, lr, lc] of legs) {
          if (!inSquare(r + lr, c + lc) || at(b, r + lr, c + lc) !== '.') continue;
          push(r, c, r + dr, c + dc);
        }
        break;
      }
      case 'R': { // 车: 直线任意
        const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc;
          while (inSquare(nr, nc)) {
            const t = at(b, nr, nc);
            if (t === '.') ms.push({ fr: r, fc: c, tr: nr, tc: nc });
            else { if (sideOf(t) !== side) ms.push({ fr: r, fc: c, tr: nr, tc: nc }); break; }
            nr += dr; nc += dc;
          }
        }
        break;
      }
      case 'C': { // 炮: 行走如车, 吃子须隔一个炮架
        const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc, jumped = false;
          while (inSquare(nr, nc)) {
            const t = at(b, nr, nc);
            if (!jumped) {
              if (t === '.') ms.push({ fr: r, fc: c, tr: nr, tc: nc });
              else jumped = true;
            } else if (t !== '.') {
              if (sideOf(t) !== side) ms.push({ fr: r, fc: c, tr: nr, tc: nc });
              break;
            }
            nr += dr; nc += dc;
          }
        }
        break;
      }
      case 'P': { // 兵/卒: 过河前只前进, 过河后可横走, 不能后退
        const dir = side === RED ? -1 : 1;
        push(r, c, r + dir, c);
        const crossed = side === RED ? r <= 4 : r >= 5;
        if (crossed) { push(r, c, r, c - 1); push(r, c, r, c + 1); }
        break;
      }
    }
  }
  return ms;
}

function applyMove(b: string[][], m: Move): string {
  const cap = at(b, m.tr, m.tc);
  put(b, m.tr, m.tc, at(b, m.fr, m.fc));
  put(b, m.fr, m.fc, '.');
  return cap;
}

function kingPos(b: string[][], side: Side): [number, number] | null {
  const k = side === RED ? 'K' : 'k';
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) if (at(b, r, c) === k) return [r, c];
  return null;
}

// 将帅照面: 同列且中间无子
function kingsFace(b: string[][]): boolean {
  const K = kingPos(b, RED), Q = kingPos(b, BLACK);
  if (!K || !Q || K[1] !== Q[1]) return false;
  for (let r = Math.min(K[0], Q[0]) + 1; r < Math.max(K[0], Q[0]); r++) if (at(b, r, K[1]) !== '.') return false;
  return true;
}

function isAttacked(b: string[][], tr: number, tc: number, bySide: Side): boolean {
  return pseudoMoves(b, bySide).some(m => m.tr === tr && m.tc === tc);
}
function inCheck(b: string[][], side: Side): boolean {
  const kp = kingPos(b, side);
  return !!kp && isAttacked(b, kp[0], kp[1], opp(side));
}

// 合法着法 = 伪合法中, 走完后己方不被将军且将帅不照面
function legalMoves(b: string[][], side: Side): Move[] {
  const out: Move[] = [];
  for (const m of pseudoMoves(b, side)) {
    const b2 = cloneBoard(b);
    applyMove(b2, m);
    if (kingsFace(b2)) continue;
    const kp = kingPos(b2, side);
    if (kp && isAttacked(b2, kp[0], kp[1], opp(side))) continue;
    out.push(m);
  }
  return out;
}

function material(b: string[][], side: Side): number {
  let s = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = at(b, r, c);
    if (p !== '.' && sideOf(p) === side) s += val(typeOf(p));
  }
  return s;
}

// ---------------- 渲染 ----------------
function renderBoard(b: string[][]): string {
  const lines: string[] = ['    ' + Array.from({ length: 9 }, (_, c) => 'c' + c).join('  ')];
  for (let r = 0; r < 10; r++) {
    lines.push(('r' + r).padEnd(4) + b[r]!.map(p => ' ' + p).join('  '));
    if (r === 4) lines.push('    ~~~~~~~~~~~ 楚 河 ═══ 汉 界 ~~~~~~~~~~~');
  }
  return lines.join('\n');
}

const mvText = (m: Move): string => `${m.fr},${m.fc}->${m.tr},${m.tc}`;

function movesBlock(b: string[][], lm: Move[]): string {
  const groups = new Map<string, string[]>();
  for (const m of lm) {
    const p = at(b, m.fr, m.fc);
    const arr = groups.get(p) || [];
    arr.push(mvText(m));
    groups.set(p, arr);
  }
  return `共 ${lm.length} 种:\n` + [...groups.entries()].map(([p, arr]) => `  ${p}(${cn(p)}): ${arr.join(' ')}`).join('\n');
}

function parseMove(s: string): Move | null {
  const m = s.trim().match(/^(\d)\s*,\s*(\d)\s*->\s*(\d)\s*,\s*(\d)$/);
  return m ? { fr: +m[1]!, fc: +m[2]!, tr: +m[3]!, tc: +m[4]! } : null;
}

// ---------------- 对弈 Agent ----------------
const RED_SYSTEM = [
  '你是中国象棋对弈 AI「赤霄」, 执红方(大写棋子 K/A/E/H/R/C/P), 棋风积极进取、擅抢攻夺中路。',
  '你只做纯局面思考: 综合出子速度、子力安全、控制要点、将军与攻杀威胁, 从裁判给出的合法着法列表中选出最优一步。',
  '严格按格式回答, 第一行 "MOVE: r,c->r,c" (必须原样复制列表中的一个着法), 第二行 "THOUGHT: 一句话意图"。',
].join('\n');

const BLACK_SYSTEM = [
  '你是中国象棋对弈 AI「玄弈」, 执黑方(小写棋子 k/a/e/h/r/c/p), 棋风稳健缜密、重防守反击与子力协调。',
  '你只做纯局面思考: 优先解除被吃/被将威胁, 守住要线, 抓住对方冒进后的反击机会, 从裁判给出的合法着法列表中选出最优一步。',
  '严格按格式回答, 第一行 "MOVE: r,c->r,c" (必须原样复制列表中的一个着法), 第二行 "THOUGHT: 一句话意图"。',
].join('\n');

const legend =
  '图例: 大写=红方(帅K 仕A 相E 马H 车R 炮C 兵P) / 小写=黑方(将k 士a 象e 马h 车r 炮c 卒p)\n' +
  '方向: 红方在下(r7~r9)向 r 减小进攻; 黑方在上(r0~r2)向 r 增大进攻; r4/r5 间为楚河汉界; 九宫 c3~c5(红 r7~r9, 黑 r0~r2)';

function buildPrompt(b: string[][], side: Side, ply: number, noCap: number, lm: Move[], history: HistoryEntry[]): string {
  const matR = material(b, RED), matB = material(b, BLACK);
  const hist = history.slice(-6).map(h => `${h.n}. ${h.side === RED ? '红' : '黑'} ${h.piece}(${cn(h.piece)}) ${h.from}->${h.to}${h.captured ? '[吃' + h.captured + ']' : ''}`).join('; ');
  const check = inCheck(b, side) ? '\n!! 你正被将军, 必须应将 !!' : '';
  return [
    `你是${side === RED ? '红方「赤霄」' : '黑方「玄弈」'}。当前局面 (第 ${ply + 1} 手, 你行棋):`,
    '', renderBoard(b), '', legend, '',
    `状态: 手数 ${ply}/${PLY_CAP} | 无吃子 ${noCap}/${NO_CAPTURE_DRAW} | 物质 红 ${matR} : 黑 ${matB} (红 ${matR - matB >= 0 ? '+' : ''}${+(matR - matB).toFixed(1)})`,
    history.length ? `最近着法: ${hist}` : '(开局)', check,
    '', `你的合法着法 (只能从中选一个):`, movesBlock(b, lm), '',
    '选一步你认为最优的着法。回答格式:',
    'MOVE: r,c->r,c',
    'THOUGHT: 一句话意图',
  ].join('\n');
}

// ---------------- 主对弈循环 ----------------
log('中国象棋双 Agent 对弈开始: 红方「赤霄」(攻击型) vs 黑方「玄弈」(稳健型)');

const red = agent('赤霄', { system: RED_SYSTEM });
const black = agent('玄弈', { system: BLACK_SYSTEM });

let board = initialBoard();
let turn: Side = RED;
let ply = 0;
let noCapture = 0;
const history: HistoryEntry[] = [];
let status = 'playing';
let winner: Side | 'draw' = 'draw';
let reason = '';

while (status === 'playing' && ply < PLY_CAP) {
  const lm = legalMoves(board, turn);
  if (lm.length === 0) {
    winner = opp(turn);
    reason = inCheck(board, turn) ? 'checkmate 绝杀' : 'stalemate 困毙';
    status = 'finished';
    break;
  }
  const actor = turn === RED ? red : black;
  const prompt = buildPrompt(board, turn, ply, noCapture, lm, history);

  let decision: MoveDecision | null = null;
  let chosen: Move | null = null;
  try {
    decision = await actor.ask<MoveDecision>(prompt);
    if (decision && decision.move) {
      const m = parseMove(decision.move);
      if (m && lm.some(x => x.fr === m.fr && x.fc === m.fc && x.tr === m.tr && x.tc === m.tc)) chosen = m;
    }
  } catch { chosen = null; }
  if (!chosen && decision) { // 非法输出 -> 重问一次
    try {
      decision = await actor.ask<MoveDecision>(prompt + `\n\n你上次的回答 "${decision.move}" 不是合法着法! 必须原样复制列表中的一个着法。`);
      if (decision && decision.move) {
        const m = parseMove(decision.move);
        if (m && lm.some(x => x.fr === m.fr && x.fc === m.fc && x.tr === m.tr && x.tc === m.tc)) chosen = m;
      }
    } catch { chosen = null; }
  }
  let fallback = false;
  if (chosen === null) { chosen = lm[Math.floor(Math.random() * lm.length)]!; fallback = true; } // 最终兜底: 随机合法着法

  const piece = at(board, chosen.fr, chosen.fc);
  const captured = applyMove(board, chosen);
  const fromStr = `${chosen.fr},${chosen.fc}`, toStr = `${chosen.tr},${chosen.tc}`;
  ply++;
  noCapture = captured === '.' ? noCapture + 1 : 0;
  history.push({
    n: ply, side: turn, piece, from: fromStr, to: toStr,
    captured: captured === '.' ? null : captured,
    thought: (fallback ? '[兜底随机] ' : '') + (decision && decision.thought ? decision.thought.slice(0, 80) : ''),
  });
  log(`第 ${ply} 手 ${turn === RED ? '红' : '黑'} ${piece}(${cn(piece)}) ${fromStr}->${toStr}${captured !== '.' ? ' 吃' + captured + '(' + cn(captured) + ')' : ''}${fallback ? ' [兜底]' : ''}`);

  const nextSide = opp(turn);
  const nextLegal = legalMoves(board, nextSide);
  if (nextLegal.length === 0) {
    winner = turn;
    reason = inCheck(board, nextSide) ? 'checkmate 绝杀' : 'stalemate 困毙';
    status = 'finished';
  } else if (noCapture >= NO_CAPTURE_DRAW) {
    winner = 'draw'; reason = 'draw 连续无吃子判和'; status = 'finished';
  } else {
    turn = nextSide;
  }
}

if (status === 'playing') { // 达到手数上限, 按物质判定
  const d = material(board, RED) - material(board, BLACK);
  winner = Math.abs(d) >= ADJUDICATE_MARGIN ? (d > 0 ? RED : BLACK) : 'draw';
  reason = 'adjudicated 达手数上限, 按物质判定';
  status = 'finished';
}

const finalBoard = renderBoard(board);
const result: GameResult = {
  winner, reason, plies: ply, finalBoard, history,
  redThoughts: history.filter(h => h.side === RED).map(h => h.thought),
  blackThoughts: history.filter(h => h.side === BLACK).map(h => h.thought),
};
log(`*** 对局结束: ${winner === 'draw' ? '和局' : winner === RED ? '红方(赤霄)胜' : '黑方(玄弈)胜'} | ${reason} | 共 ${ply} 手 ***`);
return result;