// Lê a base de projetos do Notion e devolve só os dados do repasse Tenda em JSON.
// A chave do Notion fica nas variáveis de ambiente do Netlify e nunca chega ao navegador.
//
// Variáveis de ambiente (Netlify > Project configuration > Environment variables):
//   NOTION_TOKEN        chave da integração (começa com "ntn_" ou "secret_")
//   NOTION_DB_PROJETOS  link ou ID da base de projetos (a base original, não a visualização)
//   NOTION_DB_LEGAL     (opcional) link da base de legalização; vazio ou igual à de projetos = mesma base
//   CLIENTE_ID          link ou ID da página do cliente Tenda (a que aparece na coluna CLIENTES)
//                       (opcional: sem ele, o site filtra pelo nome TENDA no título)

// Nomes das colunas no Notion. Se alguém renomear uma coluna lá, ajuste aqui.
const COLUNAS = {
  clientes: "CLIENTES",
  status: "Status",
  disciplina: "Disciplina",
  etapa: "Etapa",
  statusAtual: "Status Atual",
  entrega: "Próxima Entrega",
  pendencias: "Pendências para Próx. Etapa",
  legalStatus: "Status Legal",
  legalPrazo: "Prazo",
  legalRetorno: "Previsão de retorno",
  legalDisciplina: "Disciplina",
  // Linha do tempo (Gantt): início e fim de cada projeto/disciplina
  inicio: "Data de início adotada",
  fim: "Data de entrega",
  // (opcional) linha de produto do empreendimento
  linha: "Linha de produto",
};
// Mesmas regras de filtro da visualização TENDA no Notion
const STATUS_EXCLUIDO = "ARQUIVADO";
const LEGAL_SIGLAS = ["INC", "ELE", "SBE", "INF"]; // disciplinas que têm legalização (INF = Infraestrutura)
const DISCIPLINA_EXCLUIDA = "CRON";
const CLIENTE = "Tenda"; // nome exibido no site
const CLIENTE_TEXTO = "TENDA"; // usado no filtro pelo título se CLIENTE_ID não estiver configurado ou não achar nada
const FUSO = "America/Sao_Paulo"; // para calcular "hoje" nas próximas entregas
// Checklist por etapa: caixas de seleção do projeto com o nome "EP - Arquitetura", "PB - Estrutural"...
// Caixas sem esse prefixo (ex.: "Plano de trabalho", que é interno) ficam de fora
const CHECKLIST_PREFIXO = /^\s*(EP|AP|PL|PB|EX|PE)\s*[-–—]\s*(.+?)\s*$/i;

const API = process.env.NOTION_API_BASE || "https://api.notion.com";
const VERSAO = "2025-09-03";
const CACHE_SEGUNDOS = 300;

const env = (k) => (process.env[k] || "").trim();
// Aceita link do Notion ou ID puro e devolve o ID com hífens
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

// Uma "base" do Notion pode ter mais de uma fonte de dados; usamos a primeira
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

// Transforma qualquer tipo de propriedade do Notion em texto, lista ou data simples
function valor(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": case "rich_text":
      return (p[p.type] || []).map((t) => t.plain_text).join("").trim() || null;
    case "select": case "status":
      return p[p.type] ? p[p.type].name : null;
    case "multi_select":
      return p.multi_select.map((o) => o.name);
    case "date":
      return p.date ? p.date.start.slice(0, 10) : null;
    case "number": return p.number;
    case "checkbox": return p.checkbox;
    case "relation": return p.relation.map((r) => r.id);
    case "people": return p.people.map((u) => u.name).filter(Boolean);
    case "unique_id": return p.unique_id ? `${p.unique_id.prefix || ""}${p.unique_id.number}` : null;
    case "formula": {
      const f = p.formula;
      if (!f) return null;
      if (f.type === "date") return f.date ? f.date.start.slice(0, 10) : null;
      return f[f.type] ?? null;
    }
    case "rollup": {
      const r = p.rollup;
      if (!r) return null;
      if (r.type === "array") return r.array.map(valor).flat().filter((v) => v != null && v !== "");
      if (r.type === "date") return r.date ? r.date.start.slice(0, 10) : null;
      return r[r.type] ?? null;
    }
    default: return null;
  }
}
const texto = (v) => (Array.isArray(v) ? v.join(", ") : v == null ? null : String(v).trim() || null);
const lista = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));
const prop = (pg, nome) => valor(pg.properties[nome]);
const titulo = (pg) => {
  const p = Object.values(pg.properties).find((x) => x.type === "title");
  return valor(p) || "";
};
// Acha a coluna mesmo com diferença de acento ou maiúscula ("Data de inicio adotada" = "Data de início adotada")
const semAcento = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const colunaDe = (props, nome, ...alternativas) => {
  if (props[nome]) return nome;
  const ks = Object.keys(props), achar = (f) => ks.find((n) => f(semAcento(n)));
  return achar((n) => n === semAcento(nome)) || alternativas.map((re) => achar((n) => re.test(n))).find(Boolean);
};
// Data em qualquer formato que o Notion devolva (data, fórmula, rollup em lista, texto "dd/mm/aaaa") → "aaaa-mm-dd"
function isoDe(v) {
  if (Array.isArray(v)) return v.map(isoDe).filter(Boolean).sort()[0] || null;
  if (v && typeof v === "object" && v.start) return isoDe(v.start);
  const t = String(v ?? "").trim(); let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
// Período da linha: início pela "Data de início adotada", fim pela "Data de entrega" (ou o fim do próprio intervalo de início)
function periodo(pg, cIni, cFim) {
  const ini = cIni ? valor(pg.properties[cIni]) : null;
  const fimProp = cFim ? valor(pg.properties[cFim]) : null;
  const fim = fimProp || (cIni && pg.properties[cIni]?.date?.end ? pg.properties[cIni].date.end.slice(0, 10) : null);
  const a = isoDe(ini), b = isoDe(fim);
  if (!a || !b) return null;
  return a <= b ? { inicio: a, fim: b } : { inicio: b, fim: a };
}
const codigoDe = (t) => (String(t).match(/^\s*(\d{4,6})/) || [])[1] || null;

// Lê as caixas de seleção do checklist (marcada = concluída)
function checklistDe(pg) {
  const itens = [];
  for (const [nome, p] of Object.entries(pg.properties)) {
    if (p.type !== "checkbox") continue;
    const m = nome.match(CHECKLIST_PREFIXO);
    if (m) itens.push({ etapa: m[1].toUpperCase(), item: m[2], ok: p.checkbox });
  }
  return itens;
}

// Monta um filtro de "diferente de" / "não vazio" respeitando o tipo da coluna
function filtroTexto(esquema, nome, cond) {
  const p = esquema.properties[nome];
  if (!p) throw new Error(`Coluna "${nome}" não encontrada na base`);
  return { property: nome, [p.type]: cond };
}

export default async () => {
  const faltando = ["NOTION_TOKEN", "NOTION_DB_PROJETOS"].filter((k) => !env(k));
  if (faltando.length) {
    return Response.json({ erro: `Configuração incompleta no Netlify: ${faltando.join(", ")}` }, { status: 503 });
  }
  try {
    const avisos = [];
    const idProj = idDe(env("NOTION_DB_PROJETOS")), idLegal = idDe(env("NOTION_DB_LEGAL"));
    const mesmaBase = !idLegal || idLegal === idProj; // legalização nas próprias linhas de disciplina
    const esqProj = await fonteDe(idProj);
    const esqLegal = mesmaBase ? esqProj : await fonteDe(idLegal);

    // 1) Projetos e disciplinas da Tenda
    const regras = [
      filtroTexto(esqProj, COLUNAS.status, { does_not_equal: STATUS_EXCLUIDO }),
      filtroTexto(esqProj, COLUNAS.disciplina, { does_not_equal: DISCIPLINA_EXCLUIDA }),
      filtroTexto(esqProj, COLUNAS.disciplina, { is_not_empty: true }),
    ];
    // Coluna de clientes: usa "CLIENTES" se existir; senão procura uma relação com "client" no nome
    const props = esqProj.properties;
    if (!props[COLUNAS.clientes]) {
      const achada = Object.keys(props).find((n) => props[n].type === "relation" && /client/i.test(n));
      if (achada) COLUNAS.clientes = achada;
    }
    const tituloNome = Object.keys(props).find((n) => props[n].type === "title");
    const porTexto = { property: tituloNome, title: { contains: CLIENTE_TEXTO } };
    const clienteId = idDe(env("CLIENTE_ID"));
    let linhas = [];
    if (clienteId && props[COLUNAS.clientes]?.type === "relation") {
      linhas = await consultar(esqProj.id, { and: [{ property: COLUNAS.clientes, relation: { contains: clienteId } }, ...regras] });
      if (!linhas.length) avisos.push("CLIENTE_ID não encontrou nenhum projeto; filtrando pelo nome TENDA no título.");
    } else if (!clienteId) avisos.push("CLIENTE_ID não configurado: filtrando pelo nome TENDA no título.");
    if (!linhas.length) linhas = await consultar(esqProj.id, { and: [porTexto, ...regras] });
    if (!linhas.length) avisos.push("Nenhuma linha encontrada para a Tenda. Confira CLIENTE_ID e a conexão da base.");

    const cIni = colunaDe(props, COLUNAS.inicio, /INICIO ADOTAD/i, /DATA DE INICIO/i, /^INICIO/i);
    const cFim = colunaDe(props, COLUNAS.fim, /^DATA DE ENTREGA/i, /^DATA (DE )?FIM/i, /^ENTREGA/i);
    const cLinha = colunaDe(props, COLUNAS.linha, /LINHA/i);
    if (!cIni || !cFim) avisos.push(`Coluna "${!cIni ? COLUNAS.inicio : COLUNAS.fim}" não encontrada: o cronograma (Gantt) fica sem essas datas. Colunas com data na base: ${Object.keys(props).filter((n) => /DATA|INICIO|ENTREGA|PRAZO/i.test(semAcento(n))).join(", ")}`);
    const ehCoor = (pg) => String(prop(pg, COLUNAS.disciplina) || "").toUpperCase() === "COOR";
    const projetos = new Map();
    // Projeto a partir de uma linha: o cartão mãe (COOR) ou, sem ele, a própria linha da disciplina (ex.: projetos só de Incêndio)
    const novoProjeto = (pg) => {
      const t = titulo(pg);
      const m = t.match(/()()\[(.+?)\]/); // "25012 - Tenda [NOME DO EMPREENDIMENTO]" → nome entre colchetes; o código interno fica escondido
      return {
        id: pg.id,
        titulo: t,
        codigo: codigoDe(t),
        js: null, // a Tenda não tem código próprio no título
        nome: m ? m[3].trim() : t,
        cliente: CLIENTE,
        etapa: texto(prop(pg, COLUNAS.etapa)),
        status: texto(prop(pg, COLUNAS.statusAtual)),
        entrega: texto(prop(pg, COLUNAS.entrega)),
        pendencias: lista(prop(pg, COLUNAS.pendencias)),
        requisitos: checklistDe(pg),
        linha: cLinha ? texto(prop(pg, cLinha)) : null,
        cronograma: (() => { const per = periodo(pg, cIni, cFim); return per ? [{ etapa: texto(prop(pg, COLUNAS.etapa)), ...per }] : []; })(),
        disciplinas: [],
        legal: [],
      };
    };
    for (const pg of linhas.filter(ehCoor)) projetos.set(pg.id, novoProjeto(pg));
    if (cIni && cFim && projetos.size && ![...projetos.values()].some((p) => p.cronograma.length)) {
      const ex = linhas.find(ehCoor);
      avisos.push(`Colunas "${cIni}" (${props[cIni].type}) e "${cFim}" (${props[cFim].type}) encontradas, mas nenhum projeto (linha COOR) tem as duas datas preenchidas.${ex ? ` Exemplo "${titulo(ex)}": início=${JSON.stringify(valor(ex.properties[cIni]))}, fim=${JSON.stringify(valor(ex.properties[cFim]))}` : ""}`);
    }
    const porCodigo = new Map([...projetos.values()].map((p) => [p.codigo, p]));
    // Disciplina pertence ao projeto pelo subitem (relação) ou, se não houver, pelo código no título
    const donoDe = (pg) => {
      for (const p of Object.values(pg.properties)) {
        if (p.type === "relation") for (const r of p.relation) if (projetos.has(r.id)) return projetos.get(r.id);
      }
      return porCodigo.get(codigoDe(titulo(pg)));
    };
    for (const pg of linhas.filter((x) => !ehCoor(x))) {
      let dono = donoDe(pg);
      if (!dono) { // sem cartão mãe: a própria linha vira o projeto (comum na Tenda, em projetos só de Incêndio)
        dono = novoProjeto(pg); projetos.set(pg.id, dono); if (dono.codigo && !porCodigo.has(dono.codigo)) porCodigo.set(dono.codigo, dono);
      }
      const sigla = texto(prop(pg, COLUNAS.disciplina));
      dono.disciplinas.push({
        sigla,
        etapa: texto(prop(pg, COLUNAS.etapa)),
        status: texto(prop(pg, COLUNAS.statusAtual)),
        entrega: texto(prop(pg, COLUNAS.entrega)),
        ...(periodo(pg, cIni, cFim) || {}),
      });
      // Mesma base: Incêndio, Elétrico, SBE e Infraestrutura trazem a legalização na própria linha
      const statusLegal = mesmaBase ? texto(prop(pg, COLUNAS.legalStatus)) : null;
      if (statusLegal && LEGAL_SIGLAS.includes(String(sigla).toUpperCase())) {
        dono.legal.push({ sigla, status: statusLegal, prazo: texto(prop(pg, COLUNAS.legalPrazo)), retorno: texto(prop(pg, COLUNAS.legalRetorno)) });
      }
    }

    // 2) Legalização: só as linhas ligadas a esses projetos
    if (mesmaBase && !esqProj.properties[COLUNAS.legalStatus]) avisos.push(`Coluna "${COLUNAS.legalStatus}" não encontrada na base.`);
    if (projetos.size && !mesmaBase) {
      const tituloLegal = Object.keys(esqLegal.properties).find((k) => esqLegal.properties[k].type === "title");
      const ou = [...porCodigo.keys()].filter(Boolean).map((c) => ({ property: tituloLegal, title: { starts_with: c } }));
      const legais = await consultar(esqLegal.id, { or: ou });
      for (const pg of legais) {
        const dono = donoDe(pg);
        if (!dono) continue;
        dono.legal.push({
          sigla: texto(prop(pg, COLUNAS.legalDisciplina)),
          status: texto(prop(pg, COLUNAS.legalStatus)),
          prazo: texto(prop(pg, COLUNAS.legalPrazo)),
          retorno: texto(prop(pg, COLUNAS.legalRetorno)),
        });
      }
    }

    // Lista completa de pendências possíveis = opções do campo de múltipla seleção, na ordem do Notion
    const campoPend = esqProj.properties[COLUNAS.pendencias];
    const opcoesPendencias = campoPend && campoPend.type === "multi_select"
      ? (campoPend.multi_select?.options || []).map((o) => o.name)
      : null;

    const corpo = {
      fonte: "notion",
      atualizado: new Date().toISOString(),
      hoje: new Date().toLocaleDateString("en-CA", { timeZone: FUSO }),
      clientes: [CLIENTE],
      analistas: [], // a Tenda não tem analistas específicos
      opcoesPendencias,
      projetos: [...projetos.values()],
      avisos,
    };
    return Response.json(corpo, {
      headers: {
        // O navegador sempre pergunta; o Netlify guarda a resposta por 5 minutos
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${CACHE_SEGUNDOS}, stale-while-revalidate=${CACHE_SEGUNDOS}`,
      },
    });
  } catch (e) {
    const dica = e.status === 401 ? "A chave do Notion (NOTION_TOKEN) é inválida."
      : e.status === 404 || e.code === "object_not_found" ? "A integração não tem acesso a alguma das bases. No Notion, abra cada base e adicione a integração em ••• > Conexões."
      : e.message.replace(/^Configuração/, "Configuração");
    return Response.json({ erro: dica }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/dados" };
