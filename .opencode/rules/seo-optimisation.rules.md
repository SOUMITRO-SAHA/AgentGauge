# Astro7 SEO Engineering Standard

## Astro 7.x — Astro Components Only

**Status:** Mandatory project rules
**Research baseline:** August 31, 2026
**Framework baseline:** Astro 7.x
**Rendering philosophy:** HTML-first, static-first, zero-framework-JavaScript
**Primary search target:** Google Search, Google Images, Google Discover and Google generative Search experiences

---

# 1. Purpose

The Astro7 project MUST be engineered so that search engines receive a complete, useful, semantically correct HTML document without requiring client-side JavaScript.

SEO MUST be treated as part of the application architecture rather than something added after pages are created.

Every public page must satisfy five requirements:

1. Search engines can discover the URL.
2. Search engines can crawl the URL.
3. Search engines can understand the content directly from returned HTML.
4. Search engines can determine the preferred canonical URL.
5. Users receive a fast, accessible, useful page.

Astro components are particularly appropriate for this architecture because `.astro` components render to HTML at build time or on demand, and their frontmatter JavaScript is removed from the browser output by default.

---

# 2. Non-negotiable Astro-only architecture

## 2.1 Allowed

Production UI MAY use:

- `.astro` pages.
- `.astro` layouts.
- `.astro` components.
- Astro slots.
- Astro content collections.
- `astro:assets`.
- `astro:content`.
- `astro/zod`.
- Astro API routes/endpoints where technically necessary.
- Native HTML.
- Native CSS.
- Native browser JavaScript inside `.astro` files when progressive enhancement actually requires it.
- Official Astro infrastructure integrations such as `@astrojs/sitemap`.

## 2.2 Forbidden

The Astro7 frontend MUST NOT introduce:

- React.
- Vue.
- Svelte.
- Solid.
- Preact.
- Alpine.
- JSX.
- TSX.
- Framework component integrations.
- Framework hydration.
- `client:load`.
- `client:idle`.
- `client:visible`.
- `client:media`.
- `client:only`.
- Client-side routing for ordinary public pages.
- JavaScript-generated SEO-critical page content.
- JavaScript-generated primary navigation.
- JavaScript-generated canonical tags.
- JavaScript-generated primary headings.
- JavaScript-only pagination.

Do not install:

```text
@astrojs/react
@astrojs/vue
@astrojs/svelte
@astrojs/solid-js
@astrojs/preact
```

for this project.

SEO-critical content MUST exist in the server-produced HTML.

Google can render JavaScript, but Google explicitly documents additional crawling/rendering stages for JavaScript pages. Astro gives us no reason to create that dependency for ordinary content. Crawlable `<a href>` links and original-HTML metadata are preferred.

---

# 3. Rendering strategy

## 3.1 Static rendering is the default

The default Astro7 architecture MUST use:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
});
```

Astro itself defaults to `static`, where pages are prerendered unless explicitly configured otherwise.

Use on-demand/server rendering only when a page genuinely requires request-time information.

Examples that do NOT justify SSR:

- Blog posts.
- Landing pages.
- Product/service informational pages.
- Documentation.
- Category pages with build-time data.
- Location landing pages.
- Author pages.
- Comparison pages.
- Glossary pages.
- Marketing pages.

Even when SSR is necessary, the response MUST still contain complete SEO content in the initial HTML.

---

# 4. Mandatory site configuration

`site` MUST be configured.

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.example.com",

  output: "static",

  trailingSlash: "never",

  integrations: [sitemap()],
});
```

Replace `https://www.example.com` with the production origin.

Astro explicitly recommends setting `site` and uses it when generating canonical URLs and sitemaps.

## URL convention

Astro7 MUST select exactly one trailing-slash convention.

Recommended:

```js
trailingSlash: "never";
```

Therefore:

```text
GOOD
https://example.com/services
https://example.com/blog/astro-seo

BAD
https://example.com/services/
https://example.com/services/index.html
```

All of the following MUST agree:

- Internal links.
- Canonicals.
- Sitemap URLs.
- hreflang URLs.
- Open Graph URLs.
- redirects.
- breadcrumbs.
- structured data URLs.

Do not allow `/page` and `/page/` to behave as independently indexable pages.

Astro notes that trailing-slash handling for prerendered pages can depend on the hosting platform, so deployment configuration MUST also enforce the selected convention.

---

# 5. Required project structure

Recommended structure:

```text
src/
├── components/
│   ├── seo/
│   │   ├── SeoHead.astro
│   │   ├── StructuredData.astro
│   │   └── Breadcrumbs.astro
│   │
│   ├── Header.astro
│   ├── Footer.astro
│   └── ...
│
├── layouts/
│   ├── BaseLayout.astro
│   ├── ContentLayout.astro
│   └── ArticleLayout.astro
│
├── pages/
│   ├── index.astro
│   ├── 404.astro
│   ├── robots.txt.ts
│   └── ...
│
├── content/
│   └── ...
│
└── content.config.ts

public/
├── favicon.ico
├── favicon.svg
└── ...

astro.config.mjs
```

There MUST be one authoritative SEO component rather than hand-written metadata scattered across pages.

---

# 6. Mandatory `SeoHead.astro`

Create:

```text
src/components/seo/SeoHead.astro
```

Recommended implementation:

```astro
---
interface Alternate {
  lang: string;
  href: string;
}

interface Props {
  title: string;
  description: string;

  canonical?: string;

  image?: string;
  imageAlt?: string;

  type?: 'website' | 'article';

  noindex?: boolean;

  siteName?: string;

  publishedTime?: string;
  modifiedTime?: string;

  alternates?: Alternate[];
}

const {
  title,
  description,
  canonical,
  image,
  imageAlt = '',
  type = 'website',
  noindex = false,
  siteName,
  publishedTime,
  modifiedTime,
  alternates = [],
} = Astro.props;

if (!Astro.site) {
  throw new Error(
    'Astro.site is required. Configure `site` in astro.config.mjs.'
  );
}

const canonicalUrl = new URL(
  canonical ?? Astro.url.pathname,
  Astro.site
);

// Never canonicalize tracking/query/hash variants.
canonicalUrl.search = '';
canonicalUrl.hash = '';

const imageUrl = image
  ? new URL(image, Astro.site)
  : undefined;

const robots = noindex
  ? 'noindex, follow'
  : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
---

<title>{title}</title>

<meta
  name="description"
  content={description}
/>

<link
  rel="canonical"
  href={canonicalUrl.href}
/>

<meta
  name="robots"
  content={robots}
/>

<link
  rel="sitemap"
  href="/sitemap-index.xml"
/>

<meta property="og:type" content={type} />
<meta property="og:title" content={title} />
<meta property="og:description" content={description} />
<meta property="og:url" content={canonicalUrl.href} />

{siteName && (
  <meta property="og:site_name" content={siteName} />
)}

{imageUrl && (
  <meta property="og:image" content={imageUrl.href} />
)}

{imageUrl && imageAlt && (
  <meta property="og:image:alt" content={imageAlt} />
)}

<meta
  name="twitter:card"
  content={imageUrl ? 'summary_large_image' : 'summary'}
/>

<meta name="twitter:title" content={title} />
<meta name="twitter:description" content={description} />

{imageUrl && (
  <meta name="twitter:image" content={imageUrl.href} />
)}

{type === 'article' && publishedTime && (
  <meta
    property="article:published_time"
    content={publishedTime}
  />
)}

{type === 'article' && modifiedTime && (
  <meta
    property="article:modified_time"
    content={modifiedTime}
  />
)}

{alternates.map(({ lang, href }) => (
  <link
    rel="alternate"
    hreflang={lang}
    href={new URL(href, Astro.site!).href}
  />
))}
```

Every indexable page MUST pass:

- `title`
- `description`

Every page MUST automatically produce:

- canonical URL
- robots rule
- Open Graph metadata
- Twitter metadata

Do not duplicate these elements elsewhere.

---

# 7. Base layout contract

Every page MUST pass through one common HTML document layout.

```astro
---
import SeoHead from '../components/seo/SeoHead.astro';

interface Props {
  title: string;
  description: string;
  canonical?: string;
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
  lang?: string;
}

const {
  lang = 'en',
  ...seo
} = Astro.props;
---

<!doctype html>
<html lang={lang}>
  <head>
    <meta charset="utf-8" />

    <meta
      name="viewport"
      content="width=device-width, initial-scale=1"
    />

    <SeoHead {...seo} />

    <slot name="head" />
  </head>

  <body>
    <slot />
  </body>
</html>
```

Rules:

- `lang` MUST exist.
- `<meta charset>` MUST exist.
- viewport metadata MUST exist.
- SEO metadata MUST appear inside `<head>`.
- A page MUST NOT create a second `<title>`.
- A page MUST NOT create a second canonical.
- The layout MUST NOT invent the page `<h1>`.

---

# 8. Title rules

Every indexable page MUST have a unique, descriptive `<title>`.

Google explicitly recommends a `<title>` on every page, descriptive and concise wording, and avoiding repetitive or keyword-stuffed title text. Google may also use the visible main heading, prominent text, `og:title`, anchor text and other signals to determine its displayed result title.

## Mandatory rules

Titles MUST:

- describe that specific page;
- satisfy the page's dominant search intent;
- include the primary topic naturally;
- distinguish the page from every other indexable page;
- make sense to a human without a keyword list;
- approximately align with the visible H1.

Titles MUST NOT:

- stuff synonyms;
- repeat keywords;
- repeat the brand multiple times;
- use generic titles such as `Home`, `Article`, `Services`;
- include a year simply to appear fresh;
- claim "2026" unless the page genuinely represents 2026 information;
- be automatically changed every January without content review.

## Length

There is no Google-mandated character limit.

Therefore:

**Internal editorial target:** approximately 30–65 characters.

This is a quality guideline, NOT a build-breaking SEO requirement.

Do not blindly truncate meaningful titles to 60 characters.

Example:

```text
GOOD
Astro SEO Guide: Technical Rules for High-Performance Sites

BAD
Astro SEO | Astro SEO Tips | Best Astro SEO | SEO Astro 7
```

---

# 9. Meta-description rules

Every indexable public landing page SHOULD have a unique description.

Descriptions MUST:

- summarize the page accurately;
- communicate the main benefit or answer;
- contain important terminology naturally;
- differ between materially different pages;
- read like useful search-result copy.

Descriptions MUST NOT:

- be keyword lists;
- make unsupported promises;
- copy the same sentence across hundreds of URLs;
- contain meaningless boilerplate.

Internal editorial target:

```text
~110–170 characters
```

This is NOT a Google limit.

Google can choose page content instead of the supplied description when it believes another snippet answers the user's query better.

Therefore the actual page copy is more important than attempting to manipulate snippet length.

---

# 10. Heading hierarchy

Every indexable page MUST have one primary visible `<h1>` as an Astro7 project convention.

Example:

```astro
<main>
  <h1>Technical SEO for Astro 7</h1>

  <section>
    <h2>Canonical URLs</h2>

    <h3>Query parameters</h3>
  </section>
</main>
```

Rules:

- One primary H1.
- H1 accurately describes the page.
- H1 and title SHOULD strongly align.
- H1 MUST be visible.
- Do not hide SEO headings off-screen.
- Do not create headings solely for keywords.
- Do not skip heading levels merely for styling.
- CSS controls appearance; HTML heading elements express structure.

Avoid:

```html
<div class="heading">Technical SEO</div>
```

when this is genuinely the page heading.

Prefer:

```html
<h1>Technical SEO</h1>
```

---

# 11. Content must exist in initial HTML

Important SEO content MUST be present in the Astro-rendered response.

This includes:

- H1.
- introductory copy;
- main answer;
- product/service descriptions;
- category descriptions;
- FAQ answers;
- author information;
- prices when relevant;
- specifications;
- comparison data;
- supporting evidence;
- internal links;
- pagination links;
- breadcrumbs.

Forbidden architecture:

```html
<div id="content"></div>

<script>
  fetch('/api/page')
    .then(...)
    .then(content => {
      // render entire article
    });
</script>
```

Do this instead:

```astro
---
const content = await getContent();
---

<article>
  <h1>{content.title}</h1>
  <p>{content.introduction}</p>
</article>
```

Server/build-time data acquisition is fine.

Client-side construction of the primary document is not.

---

# 12. Content quality rules

Astro7 MUST optimize for user intent, not raw keyword insertion.

Each indexable page needs a clear reason to exist.

Before creating a URL, answer:

```text
What distinct user problem does this page solve?
```

If there is no distinct answer, do not create the page.

## Required page characteristics

A valuable page SHOULD provide some combination of:

- direct answer;
- original explanation;
- original analysis;
- first-hand experience;
- proprietary information;
- examples;
- calculations;
- screenshots;
- comparisons;
- evidence;
- expert commentary;
- useful tables;
- unique images;
- actionable instructions.

There is **no mandatory SEO word count**.

A 600-word page answering the query completely is preferable to a 2,500-word page padded with repetitive text.

Google's current generative Search guidance explicitly states that there is no ideal page length and no need to rewrite content into artificial "AI-friendly" chunks.

---

# 13. Programmatic SEO rules

Programmatic pages MAY exist only when each URL provides genuine differentiated value.

Do NOT generate thousands of pages where only:

- city name;
- product name;
- keyword;
- adjective;
- date;
- category

changes while the substance remains the same.

Example of unacceptable template logic:

```text
Best SEO Agency in Delhi
Best SEO Agency in Mumbai
Best SEO Agency in Bangalore
```

where 95% of every page is identical.

A location page should include meaningful location-specific information such as:

- services available there;
- address;
- team;
- case studies;
- local examples;
- operating information;
- customer evidence;
- location-specific FAQs;
- geographic service boundaries.

Automated generation itself is not the problem. Generating search-targeted pages without meaningful value is.

Google specifically warns against scaled AI-generated pages without added user value.

---

# 14. Internal-link architecture

Every indexable page MUST be discoverable through ordinary HTML links.

Use:

```astro
<a href="/services/technical-seo">
  Technical SEO services
</a>
```

Do not use:

```html
<div onclick="navigate('/services/technical-seo')">Technical SEO</div>
```

or:

```html
<a href="#/services/technical-seo"> Technical SEO </a>
```

Google discovers links through `<a>` elements with usable `href` values.

## Anchor-text rules

Good:

```text
Astro performance optimization
canonical URL implementation
technical SEO audit
```

Weak:

```text
click here
learn more
here
read
```

Generic CTAs are acceptable in UI when nearby context is obvious, but editorial internal links SHOULD be descriptive.

## Orphan rule

No important indexable page may be orphaned.

Every indexable page MUST receive at least one logical internal link from another indexable URL.

Preferred architecture:

```text
Home
 ├── Services
 │    ├── Technical SEO
 │    ├── Content SEO
 │    └── Astro Development
 │
 └── Resources
      ├── Astro Guide
      ├── SEO Guide
      └── Performance Guide
```

Use hub-and-spoke relationships where appropriate.

---

# 15. URL rules

URLs MUST be:

- short enough to understand;
- descriptive;
- lowercase;
- hyphen-separated;
- permanent where possible;
- free from meaningless IDs when a semantic slug exists.

Preferred:

```text
/technical-seo
/blog/astro-image-optimization
/services/seo-audit
```

Avoid:

```text
/page?id=937184
/blog/post_932_final_v2
/services/Best-SEO-Service
```

Do not change URLs merely to insert new keywords.

URL stability is more valuable than cosmetic rewriting.

---

# 16. Canonicalization rules

Every indexable page MUST emit a self-referencing canonical unless an explicit duplicate relationship requires something else.

Example:

```html
<link rel="canonical" href="https://example.com/blog/astro-seo" />
```

Canonical URLs MUST:

- use HTTPS;
- use production hostname;
- follow the chosen slash convention;
- omit tracking parameters;
- omit URL fragments;
- correspond to the intended indexable page.

Internal links and sitemap URLs MUST point to the canonical version.

Google currently considers redirects and `rel="canonical"` strong canonicalization signals, while sitemap inclusion is a weaker signal. Google also recommends linking internally to the canonical URL.

Never use:

```text
robots.txt
```

as a canonicalization mechanism.

Do not canonicalize every page to the homepage.

Do not canonicalize unique pages to category pages merely to reduce index count.

---

# 17. Query parameters

Tracking parameters MUST NOT become canonical.

Example incoming URL:

```text
https://example.com/services/seo?utm_source=linkedin&utm_campaign=q3
```

Canonical:

```text
https://example.com/services/seo
```

Filtering/sorting parameters require an explicit indexing strategy.

Example:

```text
/products?sort=price
/products?color=red
/products?view=grid
```

These SHOULD generally not create independent indexable pages unless they represent a deliberately optimized search landing page with meaningful independent value.

---

# 18. Redirect rules

When a URL permanently moves:

```text
OLD URL
        ↓ 301
NEW EQUIVALENT URL
```

Use one direct permanent redirect.

Avoid:

```text
A → B → C → D
```

Avoid redirecting unrelated deleted URLs to the homepage.

Google explicitly warns that irrelevant redirects may be treated as soft 404s.

## Important Astro static-site warning

Astro's built-in redirect configuration on a static site **without an adapter** can produce a client-side `<meta http-equiv="refresh">` instead of an HTTP status redirect.

For SEO migrations, use actual hosting/CDN 301/308 redirects or an Astro deployment configuration capable of returning HTTP redirects.

---

# 19. Sitemap requirements

Install the official sitemap integration:

```bash
npx astro add sitemap
```

Configuration:

```js
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.example.com",

  integrations: [sitemap()],
});
```

Astro's sitemap integration generates sitemap files from statically generated routes, including dynamic routes produced through `getStaticPaths()`. Dynamic SSR routes require separate handling.

The sitemap MUST contain only canonical URLs intended for indexing.

Do not include:

- draft pages;
- `noindex` pages;
- redirects;
- 404s;
- duplicate URLs;
- tracking URLs;
- staging URLs;
- search-result pages;
- thin filter/sort pages.

Google requires absolute sitemap URLs and limits one sitemap to 50,000 URLs or 50 MB uncompressed; larger sites require sitemap splitting/indexes.

---

# 20. `robots.txt`

Recommended Astro endpoint:

```ts
// src/pages/robots.txt.ts

import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  if (!site) {
    throw new Error("Astro.site is required");
  }

  const sitemap = new URL("sitemap-index.xml", site);

  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${sitemap.href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
```

Astro's official sitemap documentation supports this dynamic `robots.txt` pattern.

## Critical rule

`robots.txt` controls crawling.

`noindex` controls indexing.

Do NOT block a URL in `robots.txt` when relying on its page-level `noindex` tag, because the crawler must be able to retrieve the page to observe that instruction.

---

# 21. Staging protection

Staging, preview and development deployments MUST NOT accidentally enter the production index.

Preferred protection:

1. authentication/access control;
2. plus `noindex` as additional protection where appropriate.

Before production deployment, CI MUST verify that the production site does NOT contain:

```html
<meta name="robots" content="noindex" />
```

globally.

And production `robots.txt` MUST NOT accidentally contain:

```text
User-agent: *
Disallow: /
```

This should be considered a release-blocking failure.

---

# 22. Image SEO

Use Astro's image system wherever practical:

```astro
---
import { Image } from 'astro:assets';
import hero from '../assets/astro-seo-guide.jpg';
---

<Image
  src={hero}
  alt="Astro SEO architecture showing prerendered HTML pages"
  width={1280}
  height={720}
  priority
/>
```

Astro's `priority` option sets above-the-fold images for immediate loading using appropriate loading, decoding and fetch-priority behavior.

## Hero/LCP images

The likely LCP image MUST NOT be lazy-loaded.

Use:

```astro
<Image
  src={hero}
  alt="..."
  priority
/>
```

## Below-the-fold images

Use ordinary optimized Astro image behavior.

## Dimensions

Images MUST have known dimensions.

This reduces layout movement and helps CLS.

## Alt text

Meaningful image:

```html
alt="Technical SEO dashboard showing indexed and excluded pages"
```

Decorative image:

```html
alt=""
```

Never write:

```text
SEO SEO company best SEO service Astro SEO technical SEO
```

as alternative text.

Alt text describes the image in its context.

Astro itself requires the `alt` property for its image component, while Google recommends descriptive filenames and contextual alt text.

## Image filenames

Prefer:

```text
astro-seo-component-architecture.webp
technical-seo-audit-dashboard.webp
```

Avoid:

```text
IMG_8372.webp
image1.webp
final-final-2.webp
```

## Do not use CSS backgrounds for indexable editorial images

Google discovers standard `<img>`/`<picture>` images but does not index CSS background images in the same way.

---

# 23. Discover/social images

Important editorial pages SHOULD have a strong dedicated social/search image.

Recommended:

```text
width: >= 1200 px
high resolution
landscape-friendly
representative of the page
minimal text baked into image
```

For Discover-oriented editorial content, Google currently recommends images at least 1200 px wide, more than 300,000 total pixels, generally suitable for 16:9 presentation, together with `max-image-preview:large`.

Hence the default robots rule for indexable Astro7 pages should include:

```html
<meta name="robots" content="index, follow, max-image-preview:large" />
```

---

# 24. Core Web Vitals

Astro7 MUST target the current "good" Core Web Vitals thresholds measured at the 75th percentile:

| Metric | Required target |
| ------ | --------------: |
| LCP    |   ≤ 2.5 seconds |
| INP    |        ≤ 200 ms |
| CLS    |           ≤ 0.1 |

These are Google's current Core Web Vitals thresholds.

These targets matter more than chasing a perfect synthetic Lighthouse score.

## Performance rules

MUST:

- ship zero framework runtime;
- minimize client JavaScript;
- optimize images;
- reserve image dimensions;
- make LCP resource discoverable early;
- preload only genuinely critical resources;
- minimize font files;
- avoid render-blocking third-party scripts;
- avoid unnecessary analytics/marketing scripts;
- avoid layout shifts caused by banners and asynchronous embeds.

SHOULD:

- prerender content;
- host assets through a performant CDN;
- compress HTML/CSS/JS;
- use appropriate cache headers;
- self-host critical fonts where practical;
- load only required weights/subsets.

---

# 25. JavaScript rule

Native client JavaScript is permitted only when HTML/CSS cannot provide the required UX.

Preferred:

```astro
<button
  type="button"
  data-menu-button
  aria-expanded="false"
>
  Menu
</button>

<nav data-menu hidden>
  ...
</nav>

<script>
  const button =
    document.querySelector('[data-menu-button]');

  const menu =
    document.querySelector('[data-menu]');

  button?.addEventListener('click', () => {
    const expanded =
      button.getAttribute('aria-expanded') === 'true';

    button.setAttribute(
      'aria-expanded',
      String(!expanded)
    );

    menu?.toggleAttribute('hidden');
  });
</script>
```

Critical links and content are still HTML.

JavaScript enhances the experience rather than creating the page.

---

# 26. Structured data

Use JSON-LD.

Create:

```text
src/components/seo/StructuredData.astro
```

```astro
---
interface Props {
  data:
    | Record<string, unknown>
    | Record<string, unknown>[];
}

const { data } = Astro.props;

// Prevent HTML/script interpretation of JSON content.
const json = JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');
---

<script
  type="application/ld+json"
  set:html={json}
></script>
```

Astro supports using `set:html` with `JSON.stringify()` for JSON-LD. Because `set:html` is raw injection rather than escaped text, structured-data serialization MUST remain controlled and properly escaped.

Google generally recommends JSON-LD because it is relatively straightforward to implement and maintain.

---

# 27. Structured-data selection

Do not add every Schema.org type to every page.

Use the type that describes the actual visible content.

Recommended mapping:

| Page                     | Schema                                 |
| ------------------------ | -------------------------------------- |
| Homepage                 | `WebSite` + `Organization`             |
| Standard content page    | `WebPage` where useful                 |
| Blog/article             | `Article` or `BlogPosting`             |
| Author page              | `ProfilePage` + `Person`               |
| Hierarchical page        | `BreadcrumbList`                       |
| Genuine product page     | appropriate `Product` markup           |
| Genuine video page       | appropriate `VideoObject`              |
| Other specialist content | only applicable Google-supported types |

Structured data does NOT guarantee a rich result.

---

# 28. Structured-data accuracy rules

JSON-LD MUST describe the content users can actually see.

Never invent:

- reviews;
- ratings;
- authors;
- prices;
- availability;
- FAQs;
- publication dates;
- organization relationships;
- addresses;
- credentials.

Do not mark something as an `Article` when it is a thin product page.

Do not create FAQ schema for questions that do not exist visibly on the page.

Do not create fake five-star AggregateRating markup.

Google requires structured data to represent visible, relevant page content and explicitly prohibits misleading markup.

---

# 29. Homepage organization/site schema

Example:

```astro
---
import StructuredData
  from '../components/seo/StructuredData.astro';

if (!Astro.site) {
  throw new Error('Astro.site is required');
}

const site = Astro.site.href;

const schema = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'YOUR SITE NAME',
    url: site,
  },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'YOUR ORGANIZATION NAME',
    url: site,
    logo: new URL('/logo.png', Astro.site).href,
  },
];
---

<StructuredData data={schema} />
```

Only include properties that are true.

---

# 30. Article schema

Article pages SHOULD supply:

- headline;
- canonical URL;
- image;
- author;
- publication date;
- modified date where applicable.

Example:

```astro
---
const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',

  headline: title,

  mainEntityOfPage: canonicalUrl,

  image: heroUrl,

  datePublished:
    publishedAt.toISOString(),

  dateModified:
    updatedAt.toISOString(),

  author: {
    '@type': 'Person',
    name: author.name,
    url: authorUrl,
  },
};
---

<StructuredData data={articleSchema} />
```

The author and dates MUST also be visible to users.

---

# 31. Authorship and trust

For informational/editorial content, important articles SHOULD display:

```html
<p>
  Written by
  <a href="/authors/jane-doe"> Jane Doe </a>
</p>

<p>
  Published
  <time datetime="2026-08-10"> August 10, 2026 </time>
</p>
```

Author pages SHOULD contain genuinely useful information such as:

- full name;
- relevant experience;
- areas of expertise;
- biography;
- published content;
- relevant verified profiles where appropriate.

Do not create empty author pages purely for schema.

---

# 32. Publication and updated dates

Display `dateModified` only when the page was meaningfully changed.

Meaningful:

- facts updated;
- substantial section added;
- technical instructions revised;
- product/version information changed;
- outdated screenshots replaced;
- material corrections made.

Not meaningful:

- punctuation changed;
- one typo fixed;
- automatic date rollover;
- "updated" date changed with no content change.

Do not fake freshness.

---

# 33. Breadcrumbs

Breadcrumbs MUST be both visible HTML navigation and optionally represented through `BreadcrumbList` JSON-LD.

Visible HTML example:

```astro
<nav aria-label="Breadcrumb">
  <ol>
    <li>
      <a href="/">Home</a>
    </li>

    <li>
      <a href="/guides">Guides</a>
    </li>

    <li aria-current="page">
      Astro SEO
    </li>
  </ol>
</nav>
```

Do not generate schema breadcrumbs that disagree with the visible navigation hierarchy.

---

# 34. Pagination

Pagination MUST produce real URLs and crawlable anchors.

Example:

```astro
<nav aria-label="Pagination">
  {page > 1 && (
    <a href={`/blog/${page - 1}`}>
      Previous
    </a>
  )}

  {page < lastPage && (
    <a href={`/blog/${page + 1}`}>
      Next
    </a>
  )}
</nav>
```

Every pagination page MUST have its own canonical.

Example:

```text
/blog
      canonical → /blog

/blog/2
      canonical → /blog/2

/blog/3
      canonical → /blog/3
```

DO NOT:

```text
/blog/2 → canonical /blog
/blog/3 → canonical /blog
```

Google explicitly instructs sites to give each paginated page its own URL and canonical rather than canonicalizing all pages to the first page.

Do not make "Load more" the only way search engines can discover subsequent content.

---

# 35. 404 and deleted content

A missing page MUST return a real:

```text
404
```

or, where appropriate:

```text
410
```

Do not return HTTP `200` with:

```text
Sorry, this page doesn't exist.
```

That creates a soft-404 situation.

If the content has a direct replacement:

```text
old → 301 → replacement
```

If there is no relevant replacement, return 404/410 instead of sending everything to `/`.

---

# 36. Multilingual SEO

If Astro7 supports several languages:

- every page MUST set correct `<html lang>`;
- each language must have a stable URL;
- each localized page must use a canonical in its own language;
- hreflang references must be reciprocal;
- hreflang URLs must be absolute;
- use `x-default` where a fallback selector/default page exists.

Example:

```html
<link rel="alternate" hreflang="en" href="https://example.com/en/services" />

<link rel="alternate" hreflang="hi" href="https://example.com/hi/services" />

<link
  rel="alternate"
  hreflang="x-default"
  href="https://example.com/services"
/>
```

Do not canonicalize all translations to the English page.

---

# 37. Navigation rules

Primary navigation MUST exist in HTML.

Good:

```astro
<nav aria-label="Main navigation">
  <a href="/services">Services</a>
  <a href="/work">Work</a>
  <a href="/resources">Resources</a>
  <a href="/about">About</a>
</nav>
```

Do not make navigation discoverable only after JavaScript runs.

Mobile navigation may use JavaScript to open/close itself, but all links must exist in the initial HTML document.

---

# 38. Semantic HTML

Use the correct HTML element before inventing a generic `<div>`.

Prefer:

```text
<header>
<nav>
<main>
<article>
<section>
<aside>
<footer>
<h1>–<h6>
<figure>
<figcaption>
<time>
<address>
<ul>
<ol>
<table>
```

Semantic markup is primarily an accessibility and maintainability advantage, but it also makes the document structure explicit.

Do not create fake semantics with class names alone.

---

# 39. Content collections

For large editorial sites, metadata SHOULD be schema-validated.

Astro 7 exposes Zod 4 through:

```ts
import { z } from "astro/zod";
```

Astro content collections can validate content data and provide typed information.

Recommended metadata contract:

```ts
{
  (title, description, draft, noindex, publishedAt, updatedAt, canonical, hero, heroAlt, author);
}
```

The build SHOULD fail when a publishable page is missing required SEO data.

Example principles:

```text
title       required
description required
draft       boolean
noindex     boolean
heroAlt     required when meaningful hero exists
publishedAt required for articles
author      required for editorial articles
```

---

# 40. `noindex` policy

Use `noindex` deliberately.

Possible candidates:

- private/internal utilities;
- thin internal search pages;
- duplicate filtered views;
- temporary campaign variants;
- account pages;
- staging/preview pages.

Do not `noindex` pages merely because they rank poorly.

Fix poor-quality pages, merge them when appropriate, or remove them.

---

# 41. Open Graph and social metadata

Open Graph is mandatory for major public landing pages even though it is not a direct Google ranking system.

Required:

```html
<meta property="og:title" />
<meta property="og:description" />
<meta property="og:url" />
<meta property="og:type" />
<meta property="og:image" />
```

Article pages SHOULD also provide:

```html
<meta property="article:published_time" />
<meta property="article:modified_time" />
```

`og:title` matters additionally because Google documents it as one of several sources that can influence generated title links.

---

# 42. AI Search / GEO / AEO policy

Astro7 MUST NOT add unsupported "AI SEO" hacks simply because they are fashionable.

For Google Search:

Do NOT treat any of the following as ranking requirements:

```text
llms.txt
special AI schema
AI-only metadata
keyword chunking for LLMs
rewriting every paragraph into question/answer form
artificial long-tail keyword expansion
```

Google's 2026 generative Search documentation explicitly says:

- normal SEO fundamentals still apply;
- content needs to be crawlable/indexable;
- important information should be available in textual form;
- internal links remain important;
- structured data should correspond to visible content;
- there is no special schema for generative Search;
- Google Search does not require `llms.txt` or special AI text files.

Therefore Astro7's "AI optimization" strategy is:

```text
Excellent crawlability
+ useful original content
+ strong information architecture
+ clear entities
+ accurate structured data
+ original evidence
+ authoritative authorship
+ good UX/performance
```

not gimmicks.

An `llms.txt` file may be added for another system that explicitly consumes it, but it MUST NOT be presented internally as a Google SEO optimization.

---

# 43. Search intent rule

One URL SHOULD target one dominant intent.

Examples:

```text
/astro-seo
→ informational guide

/astro-seo-services
→ commercial/service intent

/astro-vs-nextjs
→ comparison intent
```

Do not force several fundamentally different intents into one generic page purely because keywords overlap.

Likewise, do not create several pages competing for essentially identical intent.

When two pages satisfy the same searcher need, consider:

- merging;
- repositioning;
- differentiating;
- redirecting the weaker page.

---

# 44. Keyword usage

Keywords are a content-understanding tool, not a density target.

The primary topic SHOULD naturally appear where appropriate in:

- title;
- H1;
- opening content;
- relevant H2s;
- body;
- internal anchors;
- image context;
- URL where natural.

There is NO required keyword density.

Never optimize toward:

```text
2% keyword density
3% keyword density
exact match every 100 words
```

Do not stuff semantic variants into every section.

Write naturally about the topic in sufficient depth.

---

# 45. External links and evidence

When factual content benefits from evidence, link to authoritative primary sources.

Examples:

- official documentation;
- government sources;
- standards bodies;
- original research;
- product documentation;
- official company announcements.

Do not avoid useful external links because of a myth that "linking out leaks SEO authority."

A page intended to establish expertise should make important claims verifiable where practical.

---

# 46. Search-result snippets must match reality

Never optimize title/description to promise content that the page does not deliver.

Bad:

```text
Free Astro SEO Audit Tool
```

when the page contains no tool.

Bad:

```text
Complete 2026 Pricing
```

when no pricing appears.

Bad:

```text
Download Free Template
```

when download requires something fundamentally different than expected.

Snippet promises and content must align.

---

# 47. Avoid thin boilerplate above the answer

The user should reach the useful content quickly.

Avoid:

```text
In today's rapidly evolving digital landscape...
As the world of technology continues to evolve...
SEO has become increasingly important...
```

before answering a narrow technical question.

Prefer:

```text
In Astro 7, use `site` in astro.config.mjs and generate a
self-referencing absolute canonical from `Astro.site`.
```

Answer first.

Explain second.

Add context where useful.

---

# 48. Tables, lists and structured content

Use a table when the content is genuinely comparative.

Use ordered lists when sequence matters.

Use unordered lists when the elements form a set.

Do not create dozens of shallow bullet points solely because someone believes LLMs require "chunked content."

Information architecture should serve humans first.

Google's 2026 guidance explicitly rejects mandatory content "chunking" for generative Search.

---

# 49. Accessibility and SEO must reinforce each other

Every page SHOULD satisfy basic accessibility semantics.

Mandatory examples:

- meaningful `alt`;
- keyboard-accessible interactions;
- explicit form labels;
- correct heading structure;
- `aria-expanded` for disclosure controls where relevant;
- descriptive link text;
- visible focus;
- semantic landmarks;
- sufficient contrast.

Do not use SEO techniques that harm accessibility.

---

# 50. Performance budget

For ordinary content pages, the target client JavaScript budget should be:

```text
Astro/framework JS: 0 KB
```

Additional native JavaScript should be justified feature-by-feature.

A marketing page requiring 250 KB of client JavaScript to display ordinary navigation is an architectural failure.

Third-party scripts require stronger justification than first-party scripts.

Prefer:

```text
HTML
CSS
native browser behavior
```

before JavaScript.

---

# 51. Forbidden SEO patterns

The following are prohibited:

- keyword stuffing;
- hidden SEO text;
- invisible H1s;
- doorway pages;
- fake city pages;
- fake reviews;
- fake schema ratings;
- title swapping unrelated to content;
- automatic date freshness;
- mass near-duplicate pages;
- canonicalizing unique pages away;
- `robots.txt` as canonical control;
- JavaScript-only navigation;
- JS-rendered primary content;
- infinite scroll without crawlable URL equivalents;
- orphan pages;
- fake author bios;
- duplicate metadata everywhere;
- multiple contradictory canonicals;
- shipping development/staging canonicals;
- indexing `/search?q=...` pages by default;
- redirecting every deleted page to the homepage;
- lazy-loading the LCP image;
- CSS background images for important editorial images;
- adding schema whose content is invisible;
- automatically generated "SEO paragraphs" with no user purpose;
- framework hydration for static informational UI.

---

# 52. Mandatory page-level SEO checklist

Before any public page can be considered complete, verify:

```text
[ ] Correct HTTP status
[ ] HTTPS production URL
[ ] Unique canonical
[ ] Correct trailing-slash convention
[ ] Unique title
[ ] Useful meta description
[ ] One primary visible H1
[ ] Correct heading hierarchy
[ ] Main content present in returned HTML
[ ] No framework hydration
[ ] Internal links use <a href>
[ ] Page is not orphaned
[ ] Correct robots instruction
[ ] Included/excluded from sitemap correctly
[ ] Meaningful images have alt text
[ ] Image dimensions are reserved
[ ] LCP image is not lazy-loaded
[ ] Social image is absolute and high quality
[ ] Structured data matches visible content
[ ] Breadcrumbs are accurate
[ ] Mobile layout works
[ ] No unexpected layout shift
[ ] No accidental staging metadata
```

---

# 53. CI / build SEO quality gates

Production deployment SHOULD fail when any of these are discovered:

### Critical failures

```text
Missing title
Missing canonical
Multiple canonicals
Canonical points to staging
Canonical uses HTTP
Global noindex
Production robots Disallow: /
Broken primary internal links
Sitemap contains 404
Sitemap contains redirect
Sitemap contains noindex URL
Malformed JSON-LD
Missing <html lang>
Missing required image alt
```

### Strong warnings

```text
Duplicate titles
Duplicate descriptions
Multiple project-convention H1s
Orphan URLs
Very long redirect chains
Indexable query variants
Very large page weight
Excessive client JavaScript
Missing social image
Article without author
Article without publication date
```

SEO validation should inspect the **built HTML**, not merely the source `.astro` files.

The built output is what crawlers ultimately consume.

---

# 54. Production QA

After deployment, representative templates MUST be checked through:

1. Google Search Console URL Inspection.
2. Google Rich Results Test where applicable.
3. PageSpeed Insights.
4. Chrome DevTools/Lighthouse for diagnostics.
5. Rendered page source.
6. Live HTTP headers/status codes.
7. Sitemap.
8. `robots.txt`.
9. mobile rendering.

Google itself recommends the Rich Results Test and URL Inspection when verifying structured data.

---

# 55. Core Web Vitals validation

Do not judge performance only from a developer's laptop.

After sufficient real-user traffic exists, monitor field data.

Primary thresholds:

```text
LCP ≤ 2.5 s
INP ≤ 200 ms
CLS ≤ 0.1
```

evaluated at approximately the 75th percentile.

When a template fails, fix the template architecture rather than individually patching hundreds of pages.

---

# 56. SEO component ownership

All global SEO behavior MUST flow through a small number of centralized Astro components.

Preferred ownership:

```text
SeoHead.astro
→ title
→ description
→ canonical
→ robots
→ Open Graph
→ Twitter
→ hreflang

StructuredData.astro
→ JSON-LD serialization

Breadcrumbs.astro
→ visible breadcrumbs
→ BreadcrumbList

BaseLayout.astro
→ document shell
→ language
→ viewport
```

Do not allow individual pages to recreate these systems independently.

Centralization prevents metadata drift.

---

# 57. Recommended page implementation

Example:

```astro
---
import BaseLayout
  from '../../layouts/BaseLayout.astro';

import Breadcrumbs
  from '../../components/seo/Breadcrumbs.astro';

import StructuredData
  from '../../components/seo/StructuredData.astro';

import { Image }
  from 'astro:assets';

import hero
  from '../../assets/astro-seo.jpg';

const title =
  'Astro SEO: Technical Optimization Guide';

const description =
  'Build crawlable, fast Astro pages with canonical URLs, structured data, optimized images and zero framework JavaScript.';

const canonical =
  '/guides/astro-seo';

const image =
  '/images/astro-seo-social.jpg';

const schema = {
  '@context': 'https://schema.org',
  '@type': 'Article',

  headline: title,

  mainEntityOfPage:
    new URL(canonical, Astro.site).href,

  image:
    new URL(image, Astro.site).href,

  datePublished:
    '2026-08-31T09:00:00+05:30',

  dateModified:
    '2026-08-31T09:00:00+05:30',
};
---

<BaseLayout
  title={title}
  description={description}
  canonical={canonical}
  image={image}
  imageAlt="Diagram of an Astro SEO architecture"
>
  <StructuredData
    slot="head"
    data={schema}
  />

  <main>
    <Breadcrumbs
      items={[
        { label: 'Home', href: '/' },
        { label: 'Guides', href: '/guides' },
        {
          label: 'Astro SEO',
          href: canonical
        },
      ]}
    />

    <article>
      <header>
        <h1>
          Astro SEO: Technical Optimization Guide
        </h1>

        <p>
          Build crawlable, high-performance Astro
          pages without relying on client-side
          frameworks.
        </p>
      </header>

      <Image
        src={hero}
        alt="Diagram of an Astro SEO architecture"
        priority
      />

      <section>
        <h2>
          Configure canonical URLs
        </h2>

        <p>
          ...
        </p>
      </section>
    </article>
  </main>
</BaseLayout>
```

This is the desired Astro7 pattern:

```text
Data
 ↓
Astro frontmatter
 ↓
Astro components
 ↓
Complete semantic HTML
 ↓
Browser + crawler
```

Not:

```text
Blank HTML
 ↓
framework runtime
 ↓
API
 ↓
client rendering
 ↓
eventual content
```

---

# 58. Definition of Done

A feature is NOT finished merely because it visually matches the design.

For an indexable Astro7 page, "done" means:

### Architecture

- Astro components only.
- No framework dependency.
- Critical content server/build rendered.
- Static rendering unless SSR has a documented requirement.

### Crawlability

- Returns valid status.
- Content appears in raw response HTML.
- Important links use `<a href>`.
- No accidental robots restriction.

### Indexability

- Correct `robots` directive.
- Canonical is correct.
- Sitemap policy is correct.
- No duplicate URL variant.

### Relevance

- Unique title.
- Useful H1.
- Search intent is clear.
- Main question answered.
- No filler or keyword stuffing.

### Trust

- Claims are supportable.
- Author/editor details exist when relevant.
- Dates are genuine.
- Structured data is truthful.

### Media

- Astro image optimization.
- Correct alt text.
- dimensions reserved.
- high-quality social image where applicable.
- LCP image prioritized.

### Performance

- no framework runtime;
- minimal native JavaScript;
- field CWV targets are achievable;
- unnecessary third-party code removed.

### Validation

- built HTML inspected;
- internal links checked;
- structured data validated;
- canonical verified;
- sitemap verified;
- representative production URLs tested in Search Console.

Only after all applicable requirements pass should an indexable page be considered production-ready.

---

# 59. Governing principle

When choosing between:

```text
SEO trick
```

and:

```text
clean HTML architecture
+ genuinely useful content
+ crawlable links
+ fast delivery
+ accurate metadata
```

Astro7 MUST choose the second option.

Astro's biggest SEO advantage is not a magic Astro-specific ranking factor.

Its advantage is that Astro makes it unusually easy to produce:

```text
complete HTML
+ very little JavaScript
+ optimized assets
+ static rendering
+ strong page performance
```

without a client-side framework.

The Astro7 SEO architecture must preserve that advantage.
