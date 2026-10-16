/* oxlint-disable -- recorded production script, kept verbatim as a smoke fixture */
// Smoke corpus (tests/smoke.test.ts). Source: a recorded production run, dwf_run
// dwfrun-6bca8a3d-1bc2-4cf8-ab42-fc0cd78104cc (2026-08-21). Xiangqi rules engine + two player
// agents, the larger sibling of xiangqi-two-agent-match-a: broke projectControlFlow
// (RangeError after 74 s of tree ordering) until 2026-09-03; see
// docs/analysis.md, "The control-flow graph".

// ==================== 中国象棋双 Agent 对弈工作流 ====================
// 完整规则引擎（走法生成 / 将军 / 将死 / 困毙 / 白脸将 / 重复局面）+ 红黑两个棋手 Agent

interface Move { from: number; to: number; }
interface MoveChoice { index: number; move: string; reason: string; }
interface Annotated { m: Move; text: string; }
interface GameResult {
  winner: string;
  endReason: string;
  totalPlies: number;
  finalBoard: string;
  finalMaterialRed: string;
  finalMaterialBlack: string;
  moveList: string[];
  highlights: string[];
  fallbackCount: number;
}

const LETTERS = 'abcdefghi';
const ZH: Record<string, string> = {
  K: '帅', A: '仕', B: '相', H: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', b: '象', h: '马', r: '车', c: '炮', p: '卒',
};
const VAL: Record<string, number> = {
  K: 100, A: 2, B: 2, H: 4, C: 4.5, R: 9, P: 1,
  k: 100, a: 2, b: 2, h: 4, c: 4.5, r: 9, p: 1,
};

const ORTHO: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const HORSE: [number, number, number, number][] = [
  [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
  [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
];
const ELE: [number, number][] = [[-2, -2], [-2, 2], [2, -2], [2, 2]];

const isUpper = (p: string): boolean => p >= 'A' && p <= 'Z';
const sideOf = (p: string): 'r' | 'b' => (isUpper(p) ? 'r' : 'b');
const rowOf = (s: number): number => Math.floor(s / 9);
const colOf = (s: number): number => s % 9;
const sqName = (s: number): string => (LETTERS[colOf(s)] ?? '?') + rowOf(s);
const inPalace = (r: number, c: number, side: 'r' | 'b'): boolean =>
  c >= 3 && c <= 5 && (side === 'r' ? r >= 7 : r <= 2);
const at = (b: string[], s: number): string => (s >= 0 && s < 90 ? b[s] ?? '.' : '.');

// 棋盘：90 格一维数组，下标 = 行*9+列；第 0 行为黑方底线（上方），第 9 行为红方底线（下方）
function initialBoard(): string[] {
  const b: string[] = new Array<string>(90).fill('.');
  const back = 'rhbakabhr';
  for (let c = 0; c < 9; c++) {
    const pc = back[c] ?? '.';
    b[c] = pc;
    b[81 + c] = pc.toUpperCase();
  }
  b[19] = 'c'; b[25] = 'c';
  b[64] = 'C'; b[70] = 'C';
  for (let c = 0; c < 9; c += 2) { b[27 + c] = 'p'; b[54 + c] = 'P'; }
  return b;
}

// 伪合法走法：全部兵种行棋规则（马蹩腿、象塞眼、炮隔子打、士帅限九宫、兵过河横走）
function genPseudo(board: string[], side: 'r' | 'b'): Move[] {
  const moves: Move[] = [];
  const own = (p: string): boolean => p !== '.' && sideOf(p) === side;
  const foe = (p: string): boolean => p !== '.' && sideOf(p) !== side;
  for (let s = 0; s < 90; s++) {
    const p = at(board, s);
    if (!own(p)) continue;
    const r = rowOf(s);
    const c = colOf(s);
    const up = p.toUpperCase();
    const push = (nr: number, nc: number): void => {
      if (nr < 0 || nr > 9 || nc < 0 || nc > 8) return;
      if (own(at(board, nr * 9 + nc))) return;
      moves.push({ from: s, to: nr * 9 + nc });
    };
    if (up === 'R' || up === 'C') {
      for (const [dr, dc] of ORTHO) {
        let nr = r + dr;
        let nc = c + dc;
        let screened = false;
        while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
          const t = at(board, nr * 9 + nc);
          if (up === 'R') {
            if (t === '.') moves.push({ from: s, to: nr * 9 + nc });
            else { if (foe(t)) moves.push({ from: s, to: nr * 9 + nc }); break; }
          } else if (!screened) {
            if (t === '.') moves.push({ from: s, to: nr * 9 + nc });
            else screened = true;
          } else if (t !== '.') {
            if (foe(t)) moves.push({ from: s, to: nr * 9 + nc });
            break;
          }
          nr += dr; nc += dc;
        }
      }
    } else if (up === 'H') {
      for (const [dr, dc, lr, lc] of HORSE) {
        const legR = r + lr;
        const legC = c + lc;
        if (legR < 0 || legR > 9 || legC < 0 || legC > 8) continue;
        if (at(board, legR * 9 + legC) !== '.') continue;
        push(r + dr, c + dc);
      }
    } else if (up === 'B') {
      for (const [dr, dc] of ELE) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
        if (side === 'r' ? nr < 5 : nr > 4) continue;
        if (at(board, (r + dr / 2) * 9 + (c + dc / 2)) !== '.') continue;
        push(nr, nc);
      }
    } else if (up === 'A') {
      for (const [dr, dc] of DIAG) {
        if (inPalace(r + dr, c + dc, side)) push(r + dr, c + dc);
      }
    } else if (up === 'K') {
      for (const [dr, dc] of ORTHO) {
        if (inPalace(r + dr, c + dc, side)) push(r + dr, c + dc);
      }
    } else if (up === 'P') {
      push(r + (side === 'r' ? -1 : 1), c);
      const crossed = side === 'r' ? r <= 4 : r >= 5;
      if (crossed) { push(r, c - 1); push(r, c + 1); }
    }
  }
  return moves;
}

function findKing(board: string[], side: 'r' | 'b'): number {
  const t = side === 'r' ? 'K' : 'k';
  for (let s = 0; s < 90; s++) if (at(board, s) === t) return s;
  return -1;
}

// 被将军判定：敌方任一伪合法走法能吃到本方将，或双将同列无遮拦（白脸将）
function inCheck(board: string[], side: 'r' | 'b'): boolean {
  const k = findKing(board, side);
  if (k < 0) return true;
  const enemy: 'r' | 'b' = side === 'r' ? 'b' : 'r';
  for (const m of genPseudo(board, enemy)) if (m.to === k) return true;
  const ek = findKing(board, enemy);
  if (ek >= 0 && colOf(k) === colOf(ek)) {
    const lo = Math.min(rowOf(k), rowOf(ek));
    const hi = Math.max(rowOf(k), rowOf(ek));
    let clear = true;
    for (let r = lo + 1; r < hi; r++) {
      if (at(board, r * 9 + colOf(k)) !== '.') { clear = false; break; }
    }
    if (clear) return true;
  }
  return false;
}

function applyMove(board: string[], m: Move): string[] {
  const b = board.slice();
  b[m.to] = b[m.from] ?? '.';
  b[m.from] = '.';
  return b;
}

// 完全合法走法：走完后自家老将不被将军、双将不照面
function legalMoves(board: string[], side: 'r' | 'b'): Move[] {
  const res: Move[] = [];
  for (const m of genPseudo(board, side)) {
    if (!inCheck(applyMove(board, m), side)) res.push(m);
  }
  return res;
}

function displayBoard(board: string[]): string {
  const lines: string[] = ['     a   b   c   d   e   f   g   h   i'];
  for (let r = 0; r < 10; r++) {
    const cells: string[] = [];
    for (let c = 0; c < 9; c++) {
      const p = at(board, r * 9 + c);
      if (p === '.') cells.push('．');
      else cells.push(isUpper(p) ? `(${ZH[p] ?? '?'})` : (ZH[p] ?? '?'));
    }
    lines.push(`r${r}  ` + cells.join('   '));
    if (r === 4) lines.push('    ──────── 楚 河 ── 汉 界 ────────');
  }
  return lines.join('\n');
}

function materialText(board: string[], side: 'r' | 'b'): string {
  const counts: Record<string, number> = {};
  let v = 0;
  for (const p of board) {
    if (p === '.') continue;
    if (sideOf(p) === side) {
      const val = VAL[p] || 0;
      if (val < 100) v += val;
      const name = ZH[p] ?? '?';
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  const parts = Object.keys(counts).map(k => `${k}×${counts[k] ?? 0}`).join(' ');
  return `${parts}（子力价值 ${v}）`;
}

// 为合法着法编号并标注吃子 / 将军 / 绝杀
function annotate(board: string[], moves: Move[]): Annotated[] {
  const first = moves.length > 0 ? moves[0] : undefined;
  const side: 'r' | 'b' = first ? sideOf(at(board, first.from)) : 'r';
  const enemy: 'r' | 'b' = side === 'r' ? 'b' : 'r';
  return moves.map((m, i) => {
    const after = applyMove(board, m);
    const chk = inCheck(after, enemy);
    let tag = '';
    if (chk) tag = legalMoves(after, enemy).length === 0 ? '【绝杀！】' : '【将军】';
    const t = at(board, m.to);
    const cap = t !== '.' ? ` 吃${ZH[t] ?? '?'}` : '';
    return {
      m,
      text: `#${i} ${side === 'r' ? '红' : '黑'}${ZH[at(board, m.from)] ?? '?'} ${sqName(m.from)}→${sqName(m.to)}${cap}${tag}`,
    };
  });
}

function buildPrompt(
  ply: number, side: 'r' | 'b', board: string[],
  ann: Annotated[], history: string[], checkedNow: boolean,
): string {
  const sideName = side === 'r' ? '红方' : '黑方';
  const recent = history.slice(-8).join('；');
  return [
    `【第 ${ply + 1} 手 · ${sideName}（你）走子】`,
    checkedNow ? '⚠ 你正被将军！列表中的着法均已保证可以解将。' : '当前你没有被将军。',
    `最近着法：${recent || '（开局，你先行）'}`,
    '当前局面（黑方在上 r0-r4，红方在下 r5-r9；红子带括号；坐标=列字母+行号，左上为 a0、右下为 i9）：',
    displayBoard(board),
    `你的子力：${materialText(board, side)}`,
    `对方子力：${materialText(board, side === 'r' ? 'b' : 'r')}`,
    `全部合法着法共 ${ann.length} 种（编号 0 ~ ${ann.length - 1}，象棋没有虚着，必须选一步）：`,
    ...ann.map(a => a.text),
    '请选出对己方最有利的一步。优先级：绝杀 > 安全吃大子 > 将军抢先 > 攻守要位 > 避免送子被将死。',
    `只返回 JSON：{"index": 所选编号, "move": "该编号对应的坐标(如 b0c2)", "reason": "40字内理由"}`,
  ].join('\n');
}

function resolveChoice(c: MoveChoice | null, ann: Annotated[]): Move | null {
  if (!c) return null;
  if (typeof c.index === 'number' && Number.isInteger(c.index) && c.index >= 0 && c.index < ann.length) {
    const hit = ann[c.index];
    if (hit) return hit.m;
  }
  const s = String(c.move || '').toLowerCase().replace(/[^a-i0-9]/g, '');
  const mm = /^([a-i])([0-9])([a-i])([0-9])$/.exec(s);
  if (mm) {
    const fc = LETTERS.indexOf(mm[1] ?? 'z');
    const fr = Number(mm[2] ?? '-1');
    const tc = LETTERS.indexOf(mm[3] ?? 'z');
    const tr = Number(mm[4] ?? '-1');
    if (fc >= 0 && fr >= 0 && tc >= 0 && tr >= 0) {
      const from = fr * 9 + fc;
      const to = tr * 9 + tc;
      for (const a of ann) if (a.m.from === from && a.m.to === to) return a.m;
    }
  }
  return null;
}

async function askChoice(player: Agent, prompt: string): Promise<MoveChoice | null> {
  try {
    return await player.ask<MoveChoice>(prompt);
  } catch {
    return null;
  }
}

let seed = 20260821;
function seedRnd(n: number): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return Math.floor((seed / 4294967296) * n);
}

// ==================== 对弈主流程 ====================
const redPlayer = agent('红方棋手', {
  system: '你是一位棋风凌厉、算度精准的中国象棋红方棋手（先手）。唯一目标：将死或困毙黑方老将。思考顺序：①有绝杀立即执行 ②能安全谋取大子（车马炮）就吃 ③制造将军与先手 ④出子抢位、协调阵型 ⑤时刻保证自家老将安全，绝不送子。每轮你只能从给出的合法着法编号列表中选一步，且必须以 JSON {"index":编号,"move":"所选着法坐标如 h2e2","reason":"40字内理由"} 格式作答，不得输出任何其他内容。',
});
const blackPlayer = agent('黑方棋手', {
  system: '你是一位稳健老练、擅长防守反击的中国象棋黑方棋手（后手）。唯一目标：顶住红方攻势，将死或困毙红方老将。思考顺序：①有绝杀立即执行 ②对方有杀势时优先解杀防将 ③能安全吃大子就吃 ④士象整齐、屏风马稳固，伺机反击 ⑤绝不送子。每轮你只能从给出的合法着法编号列表中选一步，且必须以 JSON {"index":编号,"move":"所选着法坐标如 b9c7","reason":"40字内理由"} 格式作答，不得输出任何其他内容。',
});

const MAX_PLIES = 140;
let board = initialBoard();
const history: string[] = [];
const moveList: string[] = [];
const highlights: string[] = [];
const checkFlags: boolean[] = [];
const posCount = new Map<string, number>();
let fallbackCount = 0;
let winner = '';
let endReason = '';
let finished = false;
let stoppedEarly = false;

log(`中国象棋对弈开始：红方先行，手数上限 ${MAX_PLIES}，双 Agent 轮流执子。`);

for (let ply = 0; ply < MAX_PLIES; ply++) {
  const side: 'r' | 'b' = ply % 2 === 0 ? 'r' : 'b';
  const sideZh = side === 'r' ? '红' : '黑';
  const enemy: 'r' | 'b' = side === 'r' ? 'b' : 'r';
  const legal = legalMoves(board, side);

  if (legal.length === 0) {
    winner = side === 'r' ? '黑方胜' : '红方胜';
    endReason = inCheck(board, side)
      ? `${sideZh}方被将死（checkmate）`
      : `${sideZh}方无子可动，困毙（stalemate）判负`;
    highlights.push(`终局（第 ${ply + 1} 手前）：${endReason}`);
    finished = true;
    break;
  }

  const ann = annotate(board, legal);
  const player = side === 'r' ? redPlayer : blackPlayer;
  const prompt = buildPrompt(ply, side, board, ann, history, inCheck(board, side));

  let choice = await askChoice(player, prompt);
  let move = resolveChoice(choice, ann);
  if (!move) {
    log(`第 ${ply + 1} 手：${sideZh}方回答无法解析，要求重答一次`);
    choice = await askChoice(
      player,
      `你上次的回答无法解析。合法编号为 0~${ann.length - 1}，请重新只返回 JSON：{"index": 编号, "move": "坐标", "reason": "理由"}`,
    );
    move = resolveChoice(choice, ann);
  }

  let fellBack = false;
  if (!move) {
    const fb = ann[seedRnd(ann.length)];
    if (fb) {
      move = fb.m;
      fellBack = true;
      fallbackCount++;
      log(`第 ${ply + 1} 手：${sideZh}方两次未给出合法着法，由引擎随机代走`);
    }
  }
  if (!move) { stoppedEarly = true; break; }

  const givesCheck = inCheck(applyMove(board, move), enemy);
  const captured = at(board, move.to);
  let desc = `${sideZh}${ZH[at(board, move.from)] ?? '?'} ${sqName(move.from)}${captured !== '.' ? '×' : '−'}${sqName(move.to)}`;
  if (captured !== '.') desc += ` 吃${ZH[captured] ?? '?'}`;
  if (givesCheck) desc += '【将军】';
  if (fellBack) desc += '（引擎代走）';

  history.push(desc);
  moveList.push(`${ply + 1}. ${desc}${choice && choice.reason && !fellBack ? `（${choice.reason}）` : ''}`);
  checkFlags.push(givesCheck);
  if (givesCheck) highlights.push(`第 ${ply + 1} 手 ${desc}`);
  if (captured !== '.' && (VAL[captured] || 0) >= 4) highlights.push(`第 ${ply + 1} 手 ${desc}`);

  board = applyMove(board, move);
  log(`第 ${ply + 1} 手 ${desc}${choice && choice.reason && !fellBack ? ` —— ${choice.reason}` : ''}`);

  const attackers = board.filter(p => p !== '.' && 'RCHPrchp'.includes(p)).length;
  if (attackers === 0) {
    winner = '和棋';
    endReason = '双方均无攻击子力（车马炮兵全失），判和';
    finished = true;
    break;
  }

  const key = board.join('') + enemy;
  const n = (posCount.get(key) || 0) + 1;
  posCount.set(key, n);
  if (n >= 3) {
    const ks = [0, 2, 4].filter(k => ply - k >= 0);
    const perpetualCheck = ks.length === 3 && ks.every(k => checkFlags[ply - k] === true);
    if (perpetualCheck) {
      winner = side === 'r' ? '黑方胜' : '红方胜';
      endReason = `${sideZh}方三次重复局面且连续长将，判负（简化长将规则）`;
    } else {
      winner = '和棋';
      endReason = '同一局面第三次出现，判和';
    }
    finished = true;
    break;
  }
}

if (!finished) {
  let rv = 0;
  let bv = 0;
  for (const p of board) {
    if (p === '.') continue;
    const v = VAL[p] || 0;
    if (v >= 100) continue;
    if (sideOf(p) === 'r') rv += v; else bv += v;
  }
  const diff = rv - bv;
  if (Math.abs(diff) >= 5) winner = diff > 0 ? '红方胜' : '黑方胜';
  else winner = '和棋';
  endReason = `${stoppedEarly ? '无合法着法提前终止' : `达到 ${MAX_PLIES} 手上限`}，按剩余子力判定（红 ${rv} : 黑 ${bv}）`;
  highlights.push(`终局：${endReason}`);
}

const result: GameResult = {
  winner,
  endReason,
  totalPlies: history.length,
  finalBoard: displayBoard(board),
  finalMaterialRed: materialText(board, 'r'),
  finalMaterialBlack: materialText(board, 'b'),
  moveList,
  highlights: Array.from(new Set(highlights)).slice(0, 30),
  fallbackCount,
};

log(`对弈结束：${winner}（${endReason}），共 ${history.length} 手。`);
return result;
