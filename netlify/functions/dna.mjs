// Lê a página do cliente na base "DNA dos CLIENTES" do Notion e devolve os tópicos e o conteúdo em JSON.
// Teste: abra <site>.netlify.app/api/dna. Se a conexão estiver certa, aparece o título da página e a lista de tópicos.
//
// Variáveis de ambiente (Netlify > Project configuration > Environment variables):
//   NOTION_TOKEN    a mesma chave já usada pelo site
//   NOTION_DB_DNA   link da base "DNA dos CLIENTES"
//   DNA_CLIENTE     (opcional) título da página do cliente no DNA; sem ela, vale o nome abaixo
const CLIENTE_PADRAO = "Tenda";
// Tipos de bloco que não vão para o site (incorporações, bases e arquivos)
const IGNORAR = new Set(["embed", "child_database", "image", "video", "file", "pdf", "bookmark", "link_preview", "breadcrumb", "table_of_contents", "unsupported"]);
const MAX_PROFUNDIDADE = 5;
const CACHE_SEGUNDOS = 300;

const API = process.env.NOTION_API_BASE || "https://api.notion.com";
const VERSAO = "2025-09-03";

const env = (k) => (process.env[k] || "").trim();
function idDe(texto) {
  // Link de página aberta "por cima" (…?p=ID) aponta para a página do parâmetro p
  const t = String(texto || "").replace(/-/g, "");
  const m = t.match(/[?&]p=([0-9a-f]{32})/i)?.slice(1) || t.match(/[0-9a-f]{32}/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function notion(caminho, metodo = "GET", corpo) {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const r = await fetch(API + caminho, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${env("NOTION_TOKEN")}`,
        "Notion-Version": VERSAO,
        "Content-Type": "application/json",
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 429) { // limite de acessos do Notion: espera e tenta de novo
      const espera = Number(r.headers.get("retry-after") || 1);
      await new Promise((ok) => setTimeout(ok, espera * 1000));
      continue;
    }
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(json.message || `Notion respondeu ${r.status}`);
      e.status = r.status; e.code = json.code;
      throw e;
    }
    return json;
  }
  throw new Error("Notion ocupado (muitas tentativas)");
}
async function fonteDe(dbId) {
  const db = await notion(`/v1/databases/${dbId}`);
  const ds = db.data_sources && db.data_sources[0];
  if (!ds) throw new Error("A base não tem fonte de dados");
  return notion(`/v1/data_sources/${ds.id}`);
}
async function consultar(fonteId, filtro) {
  const paginas = [];
  let cursor;
  do {
    const corpo = { page_size: 100, filter: filtro };
    if (cursor) corpo.start_cursor = cursor;
    const r = await notion(`/v1/data_sources/${fonteId}/query`, "POST", corpo);
    paginas.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return paginas;
}
const chave = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const tituloDe = (pg) => (Object.values(pg.properties || {}).find((p) => p.type === "title")?.title || []).map((t) => t.plain_text).join("").trim();
const textoDe = (rt) => (rt || []).map((t) => t.plain_text).join("").trim();

// Lê os blocos de uma página (e os filhos de toggles, callouts, colunas...) e simplifica
async function blocos(id, nivel = 0) {
  const lista = []; let cursor;
  do {
    const r = await notion(`/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    lista.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  const saida = [];
  for (const b of lista) {
    if (IGNORAR.has(b.type)) continue;
    const d = b[b.type] || {};
    const item = { tipo: b.type, texto: b.type === "child_page" ? d.title : textoDe(d.rich_text) };
    if (b.type === "to_do") item.feito = !!d.checked;
    if (b.type === "callout" && d.icon?.emoji) item.icone = d.icon.emoji;
    if (b.type === "table_row") item.celulas = (d.cells || []).map(textoDe);
    if (b.has_children && b.type !== "child_page" && nivel < MAX_PROFUNDIDADE) item.filhos = await blocos(b.id, nivel + 1);
    if (item.texto || item.filhos?.length || item.celulas || b.type === "divider") saida.push(item);
  }
  return saida;
}

export default async () => {
  const faltando = ["NOTION_TOKEN", "NOTION_DB_DNA"].filter((k) => !env(k));
  if (faltando.length) return Response.json({ erro: `Configuração incompleta no Netlify: ${faltando.join(", ")}` }, { status: 503 });
  try {
    const fonte = await fonteDe(idDe(env("NOTION_DB_DNA")));
    const paginas = await consultar(fonte.id);
    const nomes = paginas.map(tituloDe);
    const alvo = chave(env("DNA_CLIENTE") || CLIENTE_PADRAO);
    const pg = paginas.find((p) => chave(tituloDe(p)) === alvo) || paginas.find((p) => chave(tituloDe(p)).includes(alvo) || alvo.includes(chave(tituloDe(p))));
    if (!pg) return Response.json({ erro: `Conectado ao DNA, mas não achei a página "${env("DNA_CLIENTE") || CLIENTE_PADRAO}". Páginas encontradas: ${nomes.join(", ")}. Ajuste DNA_CLIENTE no Netlify.` }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const conteudo = await blocos(pg.id);
    const topicos = conteudo.filter((b) => b.tipo === "heading_1").map((b) => b.texto);
    return Response.json({ fonte: "notion", atualizado: new Date().toISOString(), cliente: tituloDe(pg), topicos, paginasNoDNA: nomes, conteudo }, {
      headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${CACHE_SEGUNDOS}, stale-while-revalidate=${CACHE_SEGUNDOS}` },
    });
  } catch (e) {
    const dica = e.status === 401 ? "A chave do Notion (NOTION_TOKEN) é inválida."
      : e.status === 404 || e.code === "object_not_found" ? "A integração do site ainda não tem acesso à base DNA dos CLIENTES. No Notion, abra a base e adicione a integração em ••• > Conexões."
      : e.message;
    return Response.json({ erro: dica }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/dna" };
