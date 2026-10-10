const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;
const dbName = 'ibovespa_db';
const collectionName = 'acoes_clc';

let cachedClient = null;

async function connectToDatabase() {
  if (cachedClient) return cachedClient;

  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;

  return client;
}

async function buscarCotacaoYahoo(ticker) {
  const simbolo = String(ticker).trim().replace(/\.SA$/i, '');

  if (!simbolo) return null;

  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${simbolo}.SA?interval=1d&range=1mo`;
  const quoteUrl = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(`${simbolo}.SA`)}`;

  let precoAtual = 0;
  let fechamentoAnterior = 0;

  try {
    const chartResp = await fetch(chartUrl);
    if (chartResp.ok) {
      const chartData = await chartResp.json();
      const result = chartData?.chart?.result?.[0];
      const meta = result?.meta || {};

      precoAtual = Number(meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0);
      fechamentoAnterior = Number(meta.previousClose ?? meta.regularMarketPreviousClose ?? meta.chartPreviousClose ?? precoAtual ?? 0);
    }
  } catch (error) {
    console.error('Erro no chart do Yahoo:', error.message);
  }

  if ((!precoAtual || Number.isNaN(precoAtual)) || precoAtual === 0) {
    try {
      const quoteResp = await fetch(quoteUrl);
      if (quoteResp.ok) {
        const quoteData = await quoteResp.json();
        const quote = quoteData?.quoteResponse?.result?.[0] || {};
        precoAtual = Number(quote.regularMarketPrice ?? 0);
        fechamentoAnterior = Number(quote.regularMarketPreviousClose ?? quote.previousClose ?? precoAtual ?? 0);
      }
    } catch (error) {
      console.error('Erro no quote do Yahoo:', error.message);
    }
  }

  if (!precoAtual || Number.isNaN(precoAtual) || precoAtual === 0) {
    return null;
  }

  const variacao = precoAtual - fechamentoAnterior;
  const variacaoPercentual = fechamentoAnterior
    ? (variacao / fechamentoAnterior) * 100
    : 0;

  return {
    precoAtual,
    variacao,
    variacaoPercentual
  };
}

module.exports = async (req, res) => {
  try {
    const client = await connectToDatabase();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    if (req.method === 'GET') {
      const registros = await collection.find({}).toArray();
      return res.status(200).json(registros);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    const registros = await collection.find({}).toArray();
    let atualizadas = 0;

    for (const item of registros) {
      const ticker =
        item.codigo ||
        item.sigla ||
        item.acao ||
        item.ticker ||
        item.Ticker;

      if (!ticker) continue;

      const cotacao = await buscarCotacaoYahoo(ticker);

      if (cotacao) {
        await collection.updateOne(
          { _id: item._id },
          {
            $set: {
              preco_atual: cotacao.precoAtual,
              variacao: cotacao.variacao,
              variacao_percent: cotacao.variacaoPercentual,
              ultima_atualizacao: new Date()
            }
          }
        );

        atualizadas++;
      }
    }

    return res.status(200).json({
      ok: true,
      atualizadas
    });
  } catch (error) {
    console.error('Erro ao atualizar cotações:', error);

    return res.status(500).json({
      error: 'Erro ao atualizar cotações via Yahoo Finance'
    });
  }
};