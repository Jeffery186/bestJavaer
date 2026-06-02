(function () {
  var articleIndexCache = null;
  var coverCache = new Map();
  var renderTimer = 0;

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (Array.isArray(window.$docsify.plugins) ? window.$docsify.plugins : []).concat(function articleCardsPlugin(hook) {
    hook.doneEach(function () {
      scheduleRender();
    });
  });

  startStandaloneRenderer();

  function startStandaloneRenderer() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleRender);
    } else {
      scheduleRender();
    }

    [250, 750, 1500, 3000].forEach(function (delay) {
      window.setTimeout(scheduleRender, delay);
    });

    window.addEventListener('hashchange', function () {
      scheduleRender();
      window.setTimeout(scheduleRender, 250);
    });

    var observer = new MutationObserver(function (mutations) {
      var shouldRender = mutations.some(function (mutation) {
        var target = mutation.target;

        return (
          target.nodeType === 1 &&
          (
            target.classList.contains('markdown-section') ||
            target.classList.contains('content') ||
            target.querySelector && target.querySelector('.markdown-section')
          )
        );
      });

      if (shouldRender) {
        scheduleRender();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scheduleRender() {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderArticleCards, 50);
  }

  function renderArticleCards() {
    var route = getCurrentRoute();
    var isHome = isHomeRoute(route);
    var isArticleIndex = isArticleIndexRoute(route);
    var currentMarkdownPath = getCurrentMarkdownPath(route);
    var isArticleDetail = isArticleMarkdown(currentMarkdownPath);

    document.documentElement.classList.toggle('home-page', isHome);
    document.documentElement.classList.toggle('article-index-page', isArticleIndex);
    document.documentElement.classList.toggle('article-detail-page', isArticleDetail);
    document.documentElement.classList.toggle('wide-page', isHome || isArticleIndex);

    var section = document.querySelector('.markdown-section');

    if (!section) {
      return;
    }

    if (isHome) {
      decorateHomePage(section);
    }

    if (isArticleDetail) {
      renderSeriesNav(section, currentMarkdownPath);
    }

    if (!isArticleIndex) {
      return;
    }

    Array.from(section.querySelectorAll('ul')).forEach(function (list) {
      var items = Array.from(list.children).filter(function (item) {
        return item.tagName === 'LI';
      });
      var articleItems = items.map(toArticleItem).filter(Boolean);

      if (articleItems.length < 2) {
        return;
      }

      list.classList.add('article-card-grid');
      articleItems.forEach(function (item) {
        renderCard(item);
      });
    });
  }

  function renderSeriesNav(section, currentMarkdownPath) {
    if (section.querySelector('.article-series-nav')) {
      return;
    }

    getArticleIndex().then(function (articles) {
      var activePath = getCurrentMarkdownPath(getCurrentRoute());
      var index = articles.findIndex(function (article) {
        return normalizeMarkdownPath(article.markdownPath) === normalizeMarkdownPath(currentMarkdownPath);
      });

      if (normalizeMarkdownPath(activePath) !== normalizeMarkdownPath(currentMarkdownPath) || index < 0) {
        return;
      }

      var previous = articles[index - 1] || null;
      var next = articles[index + 1] || null;

      if (!previous && !next) {
        return;
      }

      var nav = document.createElement('div');

      nav.className = 'article-series-nav';
      nav.setAttribute('aria-label', '文章连载导航');
      nav.setAttribute('role', 'navigation');
      nav.appendChild(createSeriesCard(previous, '上一篇', '已经是第一篇', 'previous'));
      nav.appendChild(createSeriesCard(next, '下一篇', '已经是最后一篇', 'next'));
      section.appendChild(nav);
    });
  }

  function createSeriesCard(article, label, fallbackTitle, direction) {
    var card = document.createElement(article ? 'a' : 'span');
    var labelNode = document.createElement('span');
    var titleNode = document.createElement('span');
    var dateNode = document.createElement('span');

    card.className = 'article-series-card is-' + direction + (article ? '' : ' is-disabled');

    if (article) {
      card.href = article.href;
    }

    labelNode.className = 'article-series-card-label';
    titleNode.className = 'article-series-card-title';
    dateNode.className = 'article-series-card-date';
    labelNode.textContent = label;
    titleNode.textContent = article ? article.title : fallbackTitle;
    dateNode.textContent = article && article.date ? article.date : '';

    card.appendChild(labelNode);
    card.appendChild(titleNode);
    card.appendChild(dateNode);

    return card;
  }

  function getArticleIndex() {
    if (articleIndexCache) {
      return articleIndexCache;
    }

    articleIndexCache = fetch('ai-articles/README.md?v=20260602-branch-back', {
      cache: 'force-cache'
    })
      .then(function (response) {
        if (!response.ok) {
          return '';
        }

        return response.text();
      })
      .then(extractArticleIndex)
      .catch(function () {
        return [];
      });

    return articleIndexCache;
  }

  function extractArticleIndex(markdown) {
    var articles = [];
    var pattern = /^\s*-\s*(\d{4}-\d{2}-\d{2})\s*-\s*\[([^\]]+)\]\(([^)]+)\)/gm;
    var match;

    while ((match = pattern.exec(markdown))) {
      var markdownPath = resolveIndexMarkdownPath(match[3]);

      if (!isArticleMarkdown(markdownPath)) {
        continue;
      }

      articles.push({
        date: match[1],
        href: toRouteHref(markdownPath),
        markdownPath: markdownPath,
        title: match[2].trim()
      });
    }

    return articles;
  }

  function resolveIndexMarkdownPath(href) {
    var cleanHref = (href || '').split('?')[0].split('#')[0].trim();

    if (!cleanHref || /^(https?:|mailto:)/i.test(cleanHref)) {
      return '';
    }

    if (cleanHref.indexOf('#/') === 0) {
      return toMarkdownPath(cleanHref);
    }

    if (cleanHref.indexOf('./') === 0) {
      cleanHref = 'ai-articles/' + cleanHref.slice(2);
    } else if (cleanHref.indexOf('ai-articles/') !== 0) {
      cleanHref = 'ai-articles/' + cleanHref.replace(/^\/+/, '');
    }

    if (!/\.md$/i.test(cleanHref)) {
      cleanHref += '.md';
    }

    return cleanHref.replace(/^\/+/, '');
  }

  function decorateHomePage(section) {
    var classes = [
      'home-reading-grid',
      'home-feature-grid',
      'home-update-list',
      'home-reason-grid'
    ];
    var classByHeading = {
      '先从这几篇开始': 'home-reading-grid',
      '新主线': 'home-feature-grid',
      '最近更新': 'home-update-list',
      '为什么值得关注': 'home-reason-grid'
    };

    Array.from(section.querySelectorAll('h2')).forEach(function (heading) {
      var listClass = classByHeading[heading.textContent.trim()];
      var next = heading.nextElementSibling;

      if (!listClass || !next || next.tagName !== 'UL') {
        return;
      }

      classes.forEach(function (className) {
        next.classList.remove(className);
      });
      next.classList.add(listClass);

      if (listClass === 'home-reading-grid') {
        renderFeaturedCards(next);
      }

      if (listClass === 'home-feature-grid') {
        renderFeatureCards(next);
      }
    });
  }

  function renderFeaturedCards(list) {
    Array.from(list.children).forEach(function (item) {
      if (item.tagName !== 'LI' || item.classList.contains('home-reading-item')) {
        return;
      }

      var link = item.querySelector('a[href]');

      if (!link) {
        return;
      }

      var markdownPath = toMarkdownPath(link.getAttribute('href') || '');

      if (!markdownPath || !isArticleMarkdown(markdownPath)) {
        return;
      }

      var summaryNode = Array.from(item.querySelectorAll('p')).find(function (paragraph) {
        return !paragraph.querySelector('a[href]');
      });

      renderFeaturedCard({
        href: toRouteHref(markdownPath),
        item: item,
        markdownPath: markdownPath,
        summary: summaryNode ? summaryNode.textContent.trim() : '',
        title: link.textContent.trim()
      });
    });
  }

  function renderFeaturedCard(article) {
    var item = article.item;
    var card = document.createElement('a');
    var media = document.createElement('span');
    var body = document.createElement('span');
    var title = document.createElement('span');
    var summary = document.createElement('span');

    item.className = 'home-reading-item';
    card.className = 'home-reading-card';
    card.href = article.href;
    media.className = 'home-reading-card-media is-loading';
    media.innerHTML = '<span>AI</span>';
    body.className = 'home-reading-card-body';
    title.className = 'home-reading-card-title';
    summary.className = 'home-reading-card-summary';
    title.textContent = article.title;
    summary.textContent = article.summary;

    body.appendChild(title);
    body.appendChild(summary);
    card.appendChild(media);
    card.appendChild(body);
    item.textContent = '';
    item.appendChild(card);

    getCover(article.markdownPath).then(function (cover) {
      media.classList.remove('is-loading');

      var image = document.createElement('img');
      image.alt = article.title;
      image.loading = 'lazy';
      image.src = cover || createGeneratedCover(article.title);
      media.textContent = '';
      media.appendChild(image);
    });
  }

  function renderFeatureCards(list) {
    Array.from(list.children).forEach(function (item) {
      if (item.tagName !== 'LI' || item.classList.contains('home-feature-item')) {
        return;
      }

      var link = item.querySelector('a[href]');

      if (!link) {
        return;
      }

      var summaryNode = Array.from(item.querySelectorAll('p')).find(function (paragraph) {
        return !paragraph.querySelector('a[href]');
      });
      var href = link.getAttribute('href') || '#/';
      var title = link.textContent.trim();
      var summary = summaryNode ? summaryNode.textContent.trim() : '';
      var card = document.createElement('a');
      var media = document.createElement('span');
      var image = document.createElement('img');
      var body = document.createElement('span');
      var titleNode = document.createElement('span');
      var summaryNodeNew = document.createElement('span');

      item.className = 'home-feature-item';
      card.className = 'home-feature-card';
      card.href = href;
      media.className = 'home-feature-card-media';
      image.alt = title;
      image.loading = 'lazy';
      image.src = createGeneratedCover(title, summary || 'cxuan-ai-labs');
      body.className = 'home-feature-card-body';
      titleNode.className = 'home-feature-card-title';
      summaryNodeNew.className = 'home-feature-card-summary';
      titleNode.textContent = title;
      summaryNodeNew.textContent = summary;

      media.appendChild(image);
      body.appendChild(titleNode);
      body.appendChild(summaryNodeNew);
      card.appendChild(media);
      card.appendChild(body);
      item.textContent = '';
      item.appendChild(card);
    });
  }

  function toArticleItem(listItem) {
    var link = listItem.querySelector('a[href]');

    if (!link) {
      return null;
    }

    var href = link.getAttribute('href') || '';
    var markdownPath = toMarkdownPath(href);

    if (!markdownPath || !isArticleMarkdown(markdownPath)) {
      return null;
    }

    var rawText = listItem.textContent.replace(/\s+/g, ' ').trim();
    var dateMatch = rawText.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*/);

    return {
      date: dateMatch ? dateMatch[1] : '',
      href: toRouteHref(markdownPath),
      item: listItem,
      markdownPath: markdownPath,
      title: link.textContent.trim()
    };
  }

  function renderCard(article) {
    var item = article.item;

    if (item.classList.contains('article-card-item')) {
      return;
    }

    var card = document.createElement('a');
    var media = document.createElement('span');
    var body = document.createElement('span');
    var date = document.createElement('span');
    var title = document.createElement('span');

    item.className = 'article-card-item';
    card.className = 'article-card';
    card.href = article.href;
    media.className = 'article-card-media is-loading';
    media.innerHTML = '<span>AI</span>';
    body.className = 'article-card-body';
    date.className = 'article-card-date';
    title.className = 'article-card-title';
    date.textContent = article.date || 'AI Article';
    title.textContent = article.title;

    body.appendChild(date);
    body.appendChild(title);
    card.appendChild(media);
    card.appendChild(body);
    item.textContent = '';
    item.appendChild(card);

    getCover(article.markdownPath).then(function (cover) {
      media.classList.remove('is-loading');

      var image = document.createElement('img');
      image.alt = article.title;
      image.loading = 'lazy';
      image.src = cover || createGeneratedCover(article.title);
      media.textContent = '';
      media.appendChild(image);
    });
  }

  function getCover(markdownPath) {
    if (coverCache.has(markdownPath)) {
      return coverCache.get(markdownPath);
    }

    var request = fetch(markdownPath + '?v=20260531-card-cover', {
      cache: 'force-cache'
    })
      .then(function (response) {
        if (!response.ok) {
          return '';
        }

        return response.text();
      })
      .then(function (markdown) {
        return extractFirstImage(markdown, markdownPath);
      })
      .catch(function () {
        return '';
      });

    coverCache.set(markdownPath, request);
    return request;
  }

  function extractFirstImage(markdown, markdownPath) {
    var imagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|<img[^>]+src=["']([^"']+)["'][^>]*>/ig;
    var imageMatch = imagePattern.exec(markdown);
    var src = imageMatch && (imageMatch[1] || imageMatch[2]);

    if (src) {
      return resolveImageSource(src, markdownPath);
    }

    return '';
  }

  function getCurrentRoute() {
    return (window.location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
  }

  function getCurrentMarkdownPath(route) {
    var path = (route || '').replace(/^\/+/, '');

    if (!path || path === 'README' || /\/README$/.test(path)) {
      return '';
    }

    if (!/\.md$/i.test(path)) {
      path += '.md';
    }

    return path;
  }

  function isArticleIndexRoute(route) {
    return (
      route === 'ai-articles' ||
      route === 'ai-articles/' ||
      route === 'ai-articles/README' ||
      /^ai-articles\/[^/]+\/README$/.test(route)
    );
  }

  function isHomeRoute(route) {
    return route === '' || route === '/' || route === 'README';
  }

  function isArticleMarkdown(path) {
    return (
      /^ai-articles\/[^/]+\/.+\.md$/.test(path) &&
      !/\/README\.md$/.test(path)
    );
  }

  function toMarkdownPath(href) {
    var route = '';

    if (href.indexOf('#/') === 0) {
      route = href.slice(2);
    } else if (href.indexOf('#/') > -1) {
      route = href.split('#/')[1];
    } else if (/\.md(?:$|[?#])/.test(href)) {
      route = resolveRelativeMarkdownPath(href);
    }

    route = route.split('?')[0].split('#')[0].replace(/^\/+/, '');

    if (!route) {
      return '';
    }

    if (!/\.md$/i.test(route)) {
      route += '.md';
    }

    return route;
  }

  function toRouteHref(markdownPath) {
    return '#/' + markdownPath.replace(/\.md$/i, '').replace(/^\/+/, '');
  }

  function normalizeMarkdownPath(markdownPath) {
    var normalized = (markdownPath || '').replace(/^\/+/, '');

    try {
      return decodeURIComponent(normalized);
    } catch (error) {
      return normalized;
    }
  }

  function resolveRelativeMarkdownPath(href) {
    var base = getCurrentRoute();

    if (!base || base === 'README') {
      base = '';
    } else if (/\/README$/.test(base)) {
      base = base.replace(/README$/, '');
    } else {
      base = base.replace(/[^/]+$/, '');
    }

    var rootPath = getSiteRootPath();
    var url = new URL(href, window.location.origin + rootPath + base);
    var path = url.pathname;

    if (path.indexOf(rootPath) === 0) {
      path = path.slice(rootPath.length);
    }

    return path.replace(/^\/+/, '');
  }

  function resolveImageSource(src, markdownPath) {
    var trimmed = (src || '').trim();

    if (/^(?:https?:)?\/\//i.test(trimmed) || /^(?:data|blob):/i.test(trimmed) || trimmed.charAt(0) === '/') {
      return trimmed;
    }

    var rootPath = getSiteRootPath();
    var articleDirectory = markdownPath.replace(/[^/]+$/, '');

    return new URL(trimmed, window.location.origin + rootPath + articleDirectory).href;
  }

  function getSiteRootPath() {
    var path = window.location.pathname;

    return path.charAt(path.length - 1) === '/' ? path : path.replace(/[^/]*$/, '');
  }

  function createGeneratedCover(title, caption) {
    var safeTitle = escapeXml(title || 'AI Article');
    var safeCaption = escapeXml(caption || 'AI notes · tools · workflow');
    var svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">',
      '<rect width="960" height="540" fill="#effaf6"/>',
      '<rect x="44" y="44" width="872" height="452" rx="24" fill="#ffffff" stroke="#bfe8dc" stroke-width="2"/>',
      '<path d="M80 388H880" stroke="#00b38a" stroke-width="8" stroke-linecap="round"/>',
      '<text x="80" y="148" fill="#008f70" font-family="Arial, sans-serif" font-size="34" font-weight="700">cxuan-ai-labs</text>',
      '<foreignObject x="80" y="194" width="800" height="150">',
      '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:44px;font-weight:800;line-height:1.28;color:#303c39;">',
      safeTitle,
      '</div>',
      '</foreignObject>',
      '<foreignObject x="80" y="426" width="800" height="52">',
      '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:600;line-height:1.35;color:#7b8a86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">',
      safeCaption,
      '</div>',
      '</foreignObject>',
      '</svg>'
    ].join('');

    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char];
    });
  }
}());
