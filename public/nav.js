// nav.js — injects a slim persistent nav bar into non-game screens.
// Include this script on index.html, library.html, builder.html.
// NOT used on host.html, player.html, join.html (full-screen game UIs).

(function () {
  const NAV_HTML = `
    <nav class="site-nav" role="navigation" aria-label="Main navigation">
      <a class="site-nav__logo" href="/">
        <span class="logo-quest">Quest</span>ron<span class="logo-pip"></span>
      </a>
      <div class="site-nav__links">
        <a href="/host">Host</a>
        <a href="/library">Library</a>
        <a href="/builder">Builder</a>
        <a href="/join" class="site-nav__join-btn btn btn-primary" style="padding:0.35rem 1rem;font-size:0.85rem;">Join</a>
      </div>
    </nav>
  `;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = NAV_HTML;
  const nav = wrapper.firstElementChild;

  // Highlight the current page link
  const path = location.pathname.replace(/\/+$/, '') || '/';
  nav.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (href !== '/' && path.startsWith(href.replace('.html', '')))) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });

  // Insert before first child of body (below any existing fixed elements)
  document.body.insertBefore(nav, document.body.firstChild);

  // Add padding-top to body so content isn't hidden behind the nav
  document.body.style.paddingTop = '52px';
  document.documentElement.style.setProperty('--nav-height', '52px');
})();
