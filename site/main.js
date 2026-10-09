// ADEUK: TITANS landing page. Plain JS, no dependencies.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** Give a lazy <video> its sources (data-src → src) once. */
function arm(video) {
  if (video.dataset.armed) return;
  video.dataset.armed = '1';
  for (const s of video.querySelectorAll('source[data-src]')) s.src = s.dataset.src;
  video.load();
}

function play(video) {
  const p = video.play();
  if (p) p.catch(() => {});
}

// ------------------------------------------------------------ starfield (pixel stars, slow drift, scroll parallax)
function starfield() {
  const cv = $('#stars');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const SCALE = 3; // one star pixel = 3 CSS px, like the game's ×3
  const COLORS = ['#ffffff', '#ffe6c2', '#ffd27a', '#c9d8ff', '#ffb0d0', '#b9a8ff'];
  let w = 0;
  let h = 0;
  let stars = [];
  function resize() {
    w = Math.ceil(innerWidth / SCALE);
    h = Math.ceil(innerHeight / SCALE);
    cv.width = w;
    cv.height = h;
    const n = Math.round((w * h) / 260);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() ** 2, // depth: near stars are rarer, brighter and move more
      c: COLORS[(Math.random() * COLORS.length) | 0],
      tw: Math.random() * Math.PI * 2,
    }));
  }
  let t = 0;
  function draw() {
    ctx.clearRect(0, 0, w, h);
    const scroll = scrollY / SCALE;
    for (const s of stars) {
      const y = (((s.y - scroll * (0.05 + s.z * 0.25) + t * (0.02 + s.z * 0.08)) % h) + h) % h;
      const x = s.x;
      // gentle twinkle (slow, low amplitude: no flashing)
      ctx.globalAlpha = 0.35 + s.z * 0.5 + Math.sin(s.tw + t * 0.02) * 0.12;
      ctx.fillStyle = s.c;
      ctx.fillRect(x | 0, y | 0, 1, 1);
      if (s.z > 0.82) {
        ctx.globalAlpha *= 0.4;
        ctx.fillRect((x | 0) - 1, y | 0, 3, 1);
        ctx.fillRect(x | 0, (y | 0) - 1, 1, 3);
      }
    }
    ctx.globalAlpha = 1;
  }
  let raf = 0;
  function loop() {
    t += 1;
    draw();
    raf = requestAnimationFrame(loop);
  }
  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion.matches) {
      draw();
      addEventListener('scroll', draw, { passive: true });
    } else {
      removeEventListener('scroll', draw);
      loop();
    }
  }
  resize();
  start();
  addEventListener('resize', () => {
    resize();
    draw();
  });
  reduceMotion.addEventListener('change', start);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else start();
  });
}

// ------------------------------------------------------------ nav
function nav() {
  const bar = $('.nav');
  const onScroll = () => bar.classList.toggle('scrolled', scrollY > innerHeight * 0.6);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

// ------------------------------------------------------------ hero and feature loops: load when near, play when visible
function loops() {
  const hero = $('#hero-video');
  const lazies = $$('video[data-lazy]');
  if (reduceMotion.matches) {
    // no autoplay: posters stay; a click on a feature clip plays it
    for (const v of lazies)
      v.parentElement.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        arm(v);
        if (v.paused) play(v);
        else v.pause();
      });
    return;
  }
  if (hero) {
    arm(hero);
    play(hero);
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) {
          arm(v);
          play(v);
        } else if (v.dataset.armed) v.pause();
      }
    },
    { rootMargin: '200px 0px' },
  );
  for (const v of lazies) io.observe(v);
  if (hero) io.observe(hero);
}

// ------------------------------------------------------------ the sound feature: opt-in audio
function soundToggle() {
  const btn = $('[data-sound-toggle]');
  const v = $('#sound-video');
  if (!btn || !v) return;
  btn.addEventListener('click', () => {
    arm(v);
    const on = btn.getAttribute('aria-pressed') !== 'true';
    v.muted = !on;
    if (on) {
      v.currentTime = 0;
      play(v);
    }
    btn.setAttribute('aria-pressed', String(on));
  });
}

// ------------------------------------------------------------ titans: hover / focus / tap plays the card's clip
function titans() {
  for (const li of $$('.titan:not(.mystery)')) {
    const v = $('video[data-titan-clip]', li);
    const card = $('.titan-card', li);
    if (!v || !card) continue;
    v.addEventListener('playing', () => v.classList.add('ready'));
    const start = () => {
      if (reduceMotion.matches && !li.dataset.tapped) return;
      arm(v);
      li.classList.add('playing');
      play(v);
    };
    const stop = () => {
      li.classList.remove('playing');
      delete li.dataset.tapped;
      v.pause();
    };
    card.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') start();
    });
    card.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') stop();
    });
    card.addEventListener('focus', start);
    card.addEventListener('blur', stop);
    card.addEventListener('click', () => {
      // touch and keyboard: toggle
      if (li.classList.contains('playing') && li.dataset.tapped) stop();
      else {
        li.dataset.tapped = '1';
        start();
      }
    });
  }
}

// ------------------------------------------------------------ dialogs
function dialogs() {
  for (const d of $$('dialog.lightbox')) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.classList.contains('lightbox-frame') || e.target.closest('[data-close]'))
        d.close();
    });
  }
  // trailer: full film with sound, opened by a click (a user gesture, so audio may start)
  const trailer = $('#trailer');
  const tv = $('#trailer-video');
  for (const b of $$('[data-open-trailer]'))
    b.addEventListener('click', () => {
      arm(tv);
      trailer.showModal();
      tv.muted = false;
      tv.currentTime = 0;
      play(tv);
    });
  trailer.addEventListener('close', () => tv.pause());

  // screenshots: the lossless frame at the largest integer scale that fits (≥ 1), else fit
  const shot = $('#shot');
  const img = $('#shot-img');
  const cap = $('#shot-cap');
  const buttons = $$('.gallery button');
  let at = 0;
  function fit() {
    const dpr = devicePixelRatio || 1;
    const maxW = innerWidth * 0.94;
    const maxH = innerHeight * 0.84;
    // integer in device pixels where possible
    const k = Math.floor(Math.min((maxW * dpr) / 640, (maxH * dpr) / 360));
    const cssW = k >= 1 ? (640 * k) / dpr : maxW;
    img.style.width = `${Math.min(cssW, maxW)}px`;
    img.style.height = 'auto';
  }
  function show(i) {
    at = (i + buttons.length) % buttons.length;
    const b = buttons[at];
    const thumb = $('img', b);
    img.src = b.dataset.full;
    img.alt = thumb.alt;
    cap.textContent = thumb.alt;
    fit();
  }
  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      show(i);
      shot.showModal();
    }),
  );
  for (const s of $$('[data-step]', shot))
    s.addEventListener('click', () => show(at + Number(s.dataset.step)));
  shot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') show(at + 1);
    if (e.key === 'ArrowLeft') show(at - 1);
  });
  addEventListener('resize', () => shot.open && fit());
}

// ------------------------------------------------------------ placeholders WJ fills in
function placeholders() {
  // social links still at "#" show as "soon" and do nothing (WJ: put the real URLs in index.html)
  for (const a of $$('[data-social]'))
    if (a.getAttribute('href') === '#') {
      a.classList.add('soon');
      a.setAttribute('aria-disabled', 'true');
      a.title = 'Coming soon';
      a.addEventListener('click', (e) => e.preventDefault());
    }
  const form = $('[data-placeholder-form]');
  if (form) form.addEventListener('submit', (e) => e.preventDefault());
}

starfield();
nav();
loops();
soundToggle();
titans();
dialogs();
placeholders();
