/* 시안 공용: 상단 메뉴 `시스템` 펼침(디자인 시스템 10절 `상단 메뉴 펼침`). 시스템 시안(sample-ui13-16-system.html)은 같은 마크업에 자체 동작을 쓴다.
   펼친 목록은 저장 공간과 보존·메일 상태·감사 이력으로 간다. Esc나 바깥을 누르면 닫는다. 동작·키보드는 제품에서 Base UI Menu에 맡긴다. */
(() => {
  const btn = document.getElementById('sys-btn');
  const menu = document.getElementById('sys-menu');
  if (!btn || !menu) return;
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('.option').focus();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-drop')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
})();
