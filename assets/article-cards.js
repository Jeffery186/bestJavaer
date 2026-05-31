(function () {
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

    document.documentElement.classList.toggle('home-page', isHome);
    document.documentElement.classList.toggle('article-index-page', isArticleIndex);
    document.documentElement.classList.toggle('wide-page', isHome || isArticleIndex);

    var section = document.querySelector('.markdown-section');

    if (!section) {
      return;
    }

    if (isHome) {
      decorateHomePage(section);
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

      if (!cover) {
        media.classList.add('is-empty');
        media.innerHTML = '<span>' + getInitials(article.title) + '</span>';
        return;
      }

      var image = document.createElement('img');
      image.alt = article.title;
      image.loading = 'lazy';
      image.src = cover;
      media.textContent = '';
      media.appendChild(image);
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

      if (!cover) {
        media.classList.add('is-empty');
        media.innerHTML = '<span>' + getInitials(article.title) + '</span>';
        return;
      }

      var image = document.createElement('img');
      image.alt = article.title;
      image.loading = 'lazy';
      image.src = cover;
      media.textContent = '';
      media.appendChild(image);
    });
  }

  function getCover(markdownPath) {
    if (coverCache.has(markdownPath)) {
      return coverCache.get(markdownPath);
    }

    var request = fetch(markdownPath + '?v=20260530-card-cover', {
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

    return extractGitHubRepositoryCover(markdown);
  }

  function extractGitHubRepositoryCover(markdown) {
    var repoPattern = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
    var repoMatch = repoPattern.exec(markdown);

    if (!repoMatch) {
      return '';
    }

    return 'https://opengraph.githubassets.com/cxuan-ai-labs/' + repoMatch[1] + '/' + repoMatch[2];
  }

  function getCurrentRoute() {
    return (window.location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
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

  function getInitials(title) {
    return (title || 'AI').replace(/\s+/g, '').slice(0, 2).toUpperCase();
  }
}());
