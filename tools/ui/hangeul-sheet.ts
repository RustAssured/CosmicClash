/**
 * Hangeul specimen sheet: every jamo family, the title words and a spread of syllables at several cell sizes.
 *   npx tsx tools/ui/hangeul-sheet.ts [cell=11] [scale=4] [out=.scratch/ui/hangeul.png]
 */
import { writePng } from '../lead/png';
import { HANGUL_CELL, compose, composeSyllable } from '../../src/ui/pixel/hangeul';

const cell = HANGUL_CELL;
const scale = parseInt(process.argv[3] ?? '4', 10);
const out = process.argv[4] ?? `.scratch/ui/hangeul-${cell}.png`;

const custom = process.argv.slice(5);
const rows: string[] = custom.length ? custom : [
  '가나다라마바사아자차카타파하',
  '각낙닥락막박삭악작착칵탁팍학',
  '갈날달랄말발살알잘찰칼탈팔할',
  '고노도로모보소오조초코토포호',
  '곡논돌롬몹봇옹좆촉콕톡폭혹',
  '구누두루무부수우주추쿠투푸후',
  '그느드르므브스으즈츠크트프흐',
  '기니디리미비시이지치키티피히',
  '개내대래매배새애재채캐태패해',
  '거너더러머버서어저처커터퍼허',
  '과놔돠롸뫄봐솨와좌촤콰톼퐈화',
  '괴뇌되뢰뫼뵈쇠외죄최쾨퇴푀회',
  '궈눠뒤뤄뭐붜숴워줘춰쿼퉈퓌휘',
  '귀뉘뒤뤼뮈뷔쉬위쥐취퀴튀퓌휘',
  '의긔늬듸릐믜븨싀',
  '아득 마지막 하나 넥서스 블랙홀',
  '초신성 행성 소행성 대전 연습 설정',
  '값 닭 읽 넋 앉 않 젊 삶 밟 핥 훑 곬',
  '까 따 빠 싸 짜 꿈 뚫 쌓 씨 짧',
];
const cw = cell + 1;
const W = 16 * cw + 8;
const H = rows.length * (cell + 4) + 8;
const px = new Uint32Array(W * H).fill(0xff1a0c08);
const ink = 0xffe2e8ee;
let y = 4;
for (const r of rows) {
  let x = 4;
  for (const ch of r) {
    const cp = ch.codePointAt(0)!;
    if (cp === 32) {
      x += cw >> 1;
      continue;
    }
    const g = composeSyllable(cp);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.data[j * g.w + i]) px[(y + j) * W + x + i] = ink;
    x += cw;
  }
  y += cell + 4;
}
writePng(out, px, W, H, scale);
console.log('wrote', out, W, H, 'sanity', compose({ l: 11, v: 0, t: 0 }).toString(16));
