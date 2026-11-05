// The AI listing analyzer. It reads offers from Allegro and never changes them. Checks that can be
// done with plain facts run without AI, so the AI only judges what facts can't show.
import { createHash } from 'node:crypto';
import { allegro } from './allegro.js';
import { reviewListing, translationEnabled } from './translate.js';

const MAX_TITLE = 75;
const SHORT_TITLE = 60;
const MIN_PHOTOS = 5;
const MIN_DESCRIPTION = 600;
const SIMILAR_TITLES = 0.9;
const LOW_CONVERSION = 0.005; // under 1 sale per 200 visits
const ENOUGH_VISITS = 200;
const LOW_RATING = 4.5;
const STOCK_WARNING_DAYS = 14;
const AI_WORKERS = 4;
const SEVERITY_COST = { high: 15, medium: 7, low: 2 };
// Bump when the AI instructions change, so listings are reviewed again.
const REVIEW_VERSION = 3;
// The same product in another colour or size is a valid separate listing, not a duplicate.
const COLOUR_STEMS = ['bial', 'czarn', 'szar', 'grafit', 'nieb', 'granat', 'czerw', 'bordo', 'roz', 'rozow', 'malin', 'fiolet', 'lilia', 'lawend', 'ziel', 'mieta', 'miet', 'oliwk', 'zolt', 'pomar', 'bez', 'bezow', 'brazow', 'krem', 'ecru', 'turkus', 'morsk', 'jasn', 'ciemn'];

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Allegro stores accented letters as HTML entities, and this page has no browser to decode them.
const ENTITIES = { oacute: 'ó', Oacute: 'Ó', sup2: '²', mdash: '—', ndash: '–', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', eacute: 'é', aacute: 'á', yacute: 'ý' };
const decodeEntities = (text) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-zA-Z0-9]+);/g, (match, name) => ENTITIES[name] ?? match);

function descriptionText(details) {
  return (details.description?.sections ?? [])
    .flatMap((section) => section.items ?? [])
    .filter((item) => item.type === 'TEXT')
    .map((item) => stripHtml(item.content ?? ''))
    .join('\n');
}

function parameters(details) {
  const product = details.productSet?.[0]?.product?.parameters ?? [];
  return [...product, ...(details.parameters ?? [])]
    .map((p) => ({ name: p.name, value: (p.values ?? []).join(', ') }))
    .filter((p) => p.name && p.value);
}

const titleWords = (title) =>
  new Set(title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ł ]/g, ' ').split(/\s+/).filter(Boolean));

function similarity(a, b) {
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / new Set([...a, ...b]).size;
}

const isColour = (word) => COLOUR_STEMS.some((stem) => word.replace(/ł/g, 'l').startsWith(stem));

function findDuplicates(listings) {
  const words = listings.map((listing) => titleWords(listing.name));
  const colours = words.map((set) => [...set].filter(isColour).sort().join(' '));
  const duplicates = new Map(listings.map((listing) => [listing.id, []]));
  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      const sameProduct = listings[i].productId && listings[i].productId === listings[j].productId;
      if (sameProduct || (colours[i] === colours[j] && similarity(words[i], words[j]) >= SIMILAR_TITLES)) {
        duplicates.get(listings[i].id).push(listings[j].id);
        duplicates.get(listings[j].id).push(listings[i].id);
      }
    }
  }
  return duplicates;
}

function factFindings(listing, duplicateIds) {
  const findings = [];
  const add = (severity, area, problem, fix) => findings.push({ severity, area, problem, fix });
  const shout = listing.name.replace(/[^\p{L}]/gu, '');

  if (listing.name.length < SHORT_TITLE) {
    add('medium', 'title', `В названии ${listing.name.length} из ${MAX_TITLE} символов.`, 'Добавьте слова, которые ищут покупатели: размер, материал, цвет.');
  }
  if (shout && shout === shout.toUpperCase()) add('medium', 'title', 'Название написано заглавными буквами.', 'Используйте обычный регистр.');
  if (listing.photoCount < MIN_PHOTOS) {
    add(listing.photoCount < 3 ? 'high' : 'medium', 'photos', `Всего ${listing.photoCount} фото.`, `Добавьте минимум ${MIN_PHOTOS}: общий вид, деталь ткани, размер, упаковка.`);
  }
  if (listing.descriptionLength < MIN_DESCRIPTION) {
    add('medium', 'description', `Короткое описание: ${listing.descriptionLength} символов.`, 'Опишите материал, размеры, уход и для чего подходит товар.');
  }
  if (listing.unfilled.length) {
    const names = listing.unfilled.map((p) => p.name ?? p.id).slice(0, 4).join(', ');
    add('high', 'parameters', `Не заполнены параметры: ${names}.`, 'Заполните их: без них товар может не попадать в фильтры поиска.');
  }
  if (listing.smart === false) {
    const failed = listing.smartFailed.slice(0, 2).join('; ');
    add('high', 'smart', `Нет метки Smart!${failed ? ` Причина: ${failed}.` : ''}`, 'Выполните условия Smart!: покупатели часто выбирают такие предложения.');
  }
  if (duplicateIds.length) {
    add('medium', 'duplicate', `Похоже на другое предложение (${duplicateIds.length}).`, 'Сравните их: объедините дубли или сделайте названия разными, чтобы они не конкурировали между собой.');
  }
  if (listing.visits >= ENOUGH_VISITS && listing.conversion !== null && listing.conversion < LOW_CONVERSION) {
    add('high', 'conversion', `${listing.visits} просмотров, но продаж всего ${listing.soldTotal}.`, 'Покупатели смотрят, но не покупают: проверьте первое фото, цену и описание.');
  }
  if (listing.daysOfStock !== null && listing.daysOfStock <= STOCK_WARNING_DAYS) {
    add('high', 'stock', `Осталось ${listing.stock} шт.: при текущих продажах хватит примерно на ${Math.ceil(listing.daysOfStock)} дн.`, 'Пополните запас: когда товар закончится, предложение потеряет продажи.');
  }
  if (listing.ratingCount >= 3 && listing.rating !== null && listing.rating < LOW_RATING) {
    add('high', 'rating', `Средняя оценка ${listing.rating} (отзывов: ${listing.ratingCount}).`, 'Прочитайте отзывы и исправьте то, на что жалуются.');
  }
  return findings;
}

function scoreOf(findings) {
  return Math.max(0, 100 - findings.reduce((sum, finding) => sum + SEVERITY_COST[finding.severity], 0));
}

// How much fixing this listing could matter: weak listings that people actually see come first.
function opportunityOf(listing, score) {
  return Math.round((100 - score) * Math.log10(10 + listing.visits + 20 * listing.sold30d));
}

const priorityOf = (opportunity) => (opportunity >= 120 ? 'high' : opportunity >= 50 ? 'medium' : 'low');

async function loadListing(offer, sales, unfilled, categories, db) {
  const details = await allegro.offerDetails(offer.id);
  const [smart, rating] = await Promise.all([allegro.offerSmart(offer.id), allegro.offerRating(offer.id)]);

  const categoryId = offer.category?.id;
  if (categoryId && !categories.has(categoryId)) categories.set(categoryId, await allegro.categoryName(categoryId));

  const recent = sales.get(offer.id) ?? { units: 0, revenue: 0 };
  const stock = offer.stock?.available ?? 0;
  const soldTotal = offer.stock?.sold ?? 0;
  const visits = offer.stats?.visitsCount ?? 0;
  const description = descriptionText(details);
  const conversations = await db('GET', `conversations?offer_id=eq.${offer.id}&select=id&limit=20`);
  const questions = conversations.length
    ? await db(
        'GET',
        `conversation_messages?conversation_id=in.(${conversations.map((c) => `"${c.id}"`).join(',')})&author=eq.buyer&select=body&order=sent_at.desc&limit=10`,
      )
    : [];

  return {
    id: offer.id,
    name: offer.name,
    image: offer.primaryImage?.url ?? details.images?.[0] ?? null,
    category: categories.get(categoryId) ?? null,
    price: Number(offer.sellingMode?.price?.amount ?? 0),
    currency: offer.sellingMode?.price?.currency ?? 'PLN',
    stock,
    soldTotal,
    sold30d: recent.units,
    revenue30d: Math.round(recent.revenue * 100) / 100,
    visits,
    watchers: offer.stats?.watchersCount ?? 0,
    conversion: visits ? soldTotal / visits : null,
    rating: rating?.totalResponses ? Number(rating.averageScore) : null,
    ratingCount: rating?.totalResponses ?? 0,
    smart: smart?.classification?.fulfilled ?? null,
    smartFailed: (smart?.conditions ?? []).filter((c) => !c.fulfilled).map((c) => c.name),
    photoCount: details.images?.length ?? 0,
    description,
    descriptionLength: description.length,
    parameters: parameters(details),
    unfilled: unfilled.get(offer.id) ?? [],
    productId: details.productSet?.[0]?.product?.id ?? null,
    daysOfStock: recent.units > 0 ? stock / (recent.units / 30) : null,
    buyerQuestions: questions.map((q) => decodeEntities(q.body).slice(0, 300)).filter(Boolean),
  };
}

// AI results are reused until the listing's text changes, so repeat runs cost almost nothing.
async function aiReview(listing, stored) {
  const hash = createHash('sha256')
    .update(JSON.stringify([REVIEW_VERSION, listing.name, listing.parameters, listing.description, listing.buyerQuestions]))
    .digest('hex');
  if (stored?.content_hash === hash) {
    return {
      hash,
      summary: stored.summary,
      findings: (stored.findings ?? []).filter((finding) => finding.source === 'ai'),
      suggestedTitle: stored.suggested_title,
    };
  }
  const review = await reviewListing(listing);
  return { hash, ...review, findings: review.findings.map((finding) => ({ ...finding, source: 'ai' })) };
}

export async function runListingAudit(auditId, db) {
  const progress = (changes) => db('PATCH', `listing_audits?id=eq.${auditId}`, changes, 'return=minimal');

  try {
    await progress({ status: 'running' });
    const offers = await allegro.listActiveOffers();
    await progress({ total: offers.length });

    const sales = await allegro.salesSince(new Date(Date.now() - 30 * 86_400_000));
    const unfilled = await allegro.unfilledParameters();
    const stored = new Map((await db('GET', 'listings?select=id,content_hash,summary,findings,suggested_title')).map((row) => [row.id, row]));
    const categories = new Map();

    const listings = [];
    for (const offer of offers) listings.push(await loadListing(offer, sales, unfilled, categories, db));
    const duplicates = findDuplicates(listings);

    let next = 0;
    let completed = 0;
    let aiFailures = 0;
    const worker = async () => {
      while (next < listings.length) {
        const listing = listings[next++];
        const ids = duplicates.get(listing.id);
        let review = { hash: null, summary: null, findings: [], suggestedTitle: null };
        if (translationEnabled) {
          review = await aiReview(listing, stored.get(listing.id)).catch((err) => {
            aiFailures += 1;
            console.error(`Listing ${listing.id} AI review failed:`, err.message);
            return review;
          });
        }

        const order = { high: 0, medium: 1, low: 2 };
        const findings = [...factFindings(listing, ids).map((f) => ({ ...f, source: 'fact' })), ...review.findings]
          .sort((a, b) => order[a.severity] - order[b.severity]);
        const score = scoreOf(findings);
        const opportunity = opportunityOf(listing, score);

        await db('POST', 'listings?on_conflict=id', {
          id: listing.id,
          name: listing.name,
          image: listing.image,
          category: listing.category,
          price: listing.price,
          currency: listing.currency,
          stock: listing.stock,
          sold_total: listing.soldTotal,
          sold_30d: listing.sold30d,
          revenue_30d: listing.revenue30d,
          visits: listing.visits,
          watchers: listing.watchers,
          conversion: listing.conversion,
          rating: listing.rating,
          rating_count: listing.ratingCount,
          smart: listing.smart,
          photo_count: listing.photoCount,
          description_length: listing.descriptionLength,
          score,
          priority: priorityOf(opportunity),
          opportunity,
          top_problem: findings[0]?.problem ?? null,
          summary: review.summary,
          findings,
          duplicate_of: ids,
          suggested_title: review.suggestedTitle,
          content_hash: review.hash,
          analyzed_at: new Date().toISOString(),
        }, 'resolution=merge-duplicates,return=minimal');

        completed += 1;
        await progress({ completed });
      }
    };
    await Promise.all(Array.from({ length: AI_WORKERS }, worker));

    // Listings that ended since the last run shouldn't stay on the list.
    const active = new Set(offers.map((offer) => offer.id));
    const gone = [...stored.keys()].filter((id) => !active.has(id));
    if (gone.length) await db('DELETE', `listings?id=in.(${gone.map((id) => `"${id}"`).join(',')})`);

    await progress({
      status: 'done',
      finished_at: new Date().toISOString(),
      error: aiFailures ? `AI review failed for ${aiFailures} listings. Facts are still shown.` : null,
    });
    console.log(`Listing audit done: ${listings.length} listings, ${aiFailures} AI failures.`);
  } catch (err) {
    await progress({ status: 'failed', error: 'The analysis stopped. Try again.', finished_at: new Date().toISOString() }).catch(() => {});
    throw err;
  }
}
