#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ESEARCH_URL =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const USER_AGENT = "FemaleAutismResearchBot/1.0 (research aggregator)";

const SEARCH_QUERIES = [
  '(autis*[tiab] OR "autism spectrum disorder"[tiab] OR "Autism Spectrum Disorder"[Mesh]) AND (female*[tiab] OR women[tiab] OR girl*[tiab] OR "sex difference*"[tiab] OR "gender difference*"[tiab])',
  '(autis*[tiab]) AND ("female autism phenotype"[tiab] OR camoufl*[tiab] OR mask*[tiab] OR compensat*[tiab] OR "social camouflage"[tiab] OR underdiagnos*[tiab] OR "late diagnos*"[tiab])',
  '(autis*[tiab]) AND (female*[tiab] OR women[tiab] OR girl*[tiab]) AND (depress*[tiab] OR anxi*[tiab] OR suicid*[tiab] OR "eating disorder*"[tiab] OR anorexia[tiab] OR ARFID[tiab] OR menstrual[tiab] OR pregnancy[tiab] OR menopause[tiab] OR "lived experience*"[tiab] OR stigma[tiab] OR neurodiversity[tiab])',
];

function parseArgs(args) {
  const opts = { days: 7, maxPapers: 50, output: "" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) opts.days = parseInt(args[++i]);
    if (args[i] === "--max-papers" && args[i + 1])
      opts.maxPapers = parseInt(args[++i]);
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const lookback = d.toISOString().split("T")[0].replace(/-/g, "/");
  return `"${lookback}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(query, retmax) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(retmax),
    sort: "date",
    retmode: "json",
  });
  const resp = await fetch(`${ESEARCH_URL}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`esearch HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.esearchresult?.idlist || [];
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status === 429) {
      const wait = (attempt + 1) * 5000;
      console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  }
  throw new Error(`HTTP 429 after ${maxRetries} retries`);
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const allPapers = [];
  const batchSize = 50;
  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      db: "pubmed",
      id: batch.join(","),
      retmode: "xml",
    });
    const resp = await fetchWithRetry(`${EFETCH_URL}?${params}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    allPapers.push(...parseXmlArticles(xml));
    if (i + batchSize < pmids.length) await sleep(1000);
  }
  return allPapers;
}

function parseXmlArticles(xml) {
  const papers = [];
  const blocks = xml.split("<PubmedArticle>");
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split("</PubmedArticle>")[0];
    if (!block) continue;

    const title = extractTag(block, "ArticleTitle");
    const journal = extractJournal(block);
    const abstract = extractAbstract(block);
    const pmid = extractTag(block, "PMID");
    const date = extractDate(block);
    const keywords = extractKeywords(block);
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    if (title) {
      papers.push({ pmid, title, journal, date, abstract, url, keywords });
    }
  }
  return papers;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function extractJournal(block) {
  const m = block.match(/<Title>([\s\S]*?)<\/Title>/);
  return m ? m[1].trim() : "";
}

function extractAbstract(block) {
  const parts = [];
  const re = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const labelM = m[0].match(/Label="([^"]*)"/);
    const label = labelM ? labelM[1] : "";
    const text = m[1].replace(/<[^>]+>/g, "").trim();
    if (text) parts.push(label ? `${label}: ${text}` : text);
  }
  return parts.join(" ").substring(0, 2000);
}

function extractDate(block) {
  const m = block.match(
    /<PubDate>([\s\S]*?)<\/PubDate>/
  );
  if (!m) return "";
  const y = m[1].match(/<Year>(.*?)<\/Year>/);
  const mo = m[1].match(/<Month>(.*?)<\/Month>/);
  const d = m[1].match(/<Day>(.*?)<\/Day>/);
  return [y?.[1], mo?.[1], d?.[1]].filter(Boolean).join(" ");
}

function extractKeywords(block) {
  const kws = [];
  const re = /<Keyword>(.*?)<\/Keyword>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[1].trim()) kws.push(m[1].trim());
  }
  return kws;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dateFilter = buildDateFilter(opts.days);
  const allPmids = new Set();

  for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
    const q = SEARCH_QUERIES[qi];
    const fullQuery = `${q} AND ${dateFilter}`;
    try {
      const ids = await searchPapers(fullQuery, opts.maxPapers);
      ids.forEach((id) => allPmids.add(id));
      console.error(`[INFO] Query ${qi + 1}/${SEARCH_QUERIES.length} found ${ids.length} PMIDs`);
    } catch (e) {
      console.error(`[WARN] Search query failed: ${e.message}`);
    }
    if (qi < SEARCH_QUERIES.length - 1) await sleep(500);
  }

  const pmidList = [...allPmids];
  console.error(`[INFO] Unique PMIDs: ${pmidList.length}`);

  let papers = [];
  if (pmidList.length > 0) {
    try {
      papers = await fetchDetails(pmidList.slice(0, opts.maxPapers));
      console.error(`[INFO] Fetched details for ${papers.length} papers`);
    } catch (e) {
      console.error(`[ERROR] Fetch details failed: ${e.message}`);
    }
  }

  const now = new Date();
  const taipeiOffset = 8 * 60 * 60 * 1000;
  const taipeiTime = new Date(now.getTime() + taipeiOffset);
  const dateStr = taipeiTime.toISOString().split("T")[0];

  const output = {
    date: dateStr,
    count: papers.length,
    papers,
  };

  const json = JSON.stringify(output, null, 2);
  if (opts.output) {
    writeFileSync(resolve(opts.output), json, "utf-8");
    console.error(`[INFO] Saved to ${opts.output}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
