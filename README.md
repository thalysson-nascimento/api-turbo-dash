# Turbo Dash API

API em Next.js 16 (App Router), TypeScript e Prisma 6.19.3. O jogo Unity está integrado em `C:/Users/thalysson/projetos/cruiser-rush/Cruiser Rush`.

## Executar localmente

Use Node.js 22 ou superior. O Node instalado originalmente neste computador é antigo; durante a implementação foi utilizado o Node 24 que acompanha o Codex.

Os comandos npm agora selecionam automaticamente o Node compatível do Codex neste computador quando o Node padrão é antigo. Em outras máquinas, instale Node 22+ ou indique seu executável na variável `TURBO_DASH_NODE`. As credenciais devem ficar no `.env`, que é ignorado pelo Git; `.env.example` contém somente exemplos sem senha real.

```powershell
npm install
# Crie .env com esta variável para desenvolvimento:
# DATABASE_URL="file:./dev.db"
npm run db:local
npm run dev
```

A API escuta na porta 3000 e em todas as interfaces de rede. Teste `http://localhost:3000/api/v1/health`.

O SQLite local fica em `prisma/local/dev.db`; não o exclua se quiser preservar as contas. As migrações do SQLite e do PostgreSQL ficam separadas, com os mesmos modelos e relacionamentos.

Para compilar mantendo o SQLite local, use `npm run build:local`. No Windows, pare a API antes de gerar novamente o Prisma Client, pois o processo mantém o arquivo do banco/driver em uso. `npm run build` é o build PostgreSQL de produção; após utilizá-lo, rode `npm run db:local` antes de voltar ao desenvolvimento com SQLite.

## Um único arquivo para trocar a URL do jogo

Edite **`Assets/CruiserRush/Scripts/ApiConfig.cs`**, no projeto Unity, e altere somente:

```csharp
public const string BaseUrl = "https://sua-api.vercel.app";
```

Não acrescente `/api/v1`: o cliente já faz isso. Depois recompile o app/APK.

Para teste local no Android, foi configurado `http://192.168.15.18:3000`, o IP atual do computador. Celular e computador precisam estar na mesma rede Wi-Fi; a porta 3000 precisa estar acessível. Se esse IP mudar, troque no mesmo arquivo. No Editor também é possível usar `http://localhost:3000`.

O script de Editor `ApiNetworkSettings.cs` configura automaticamente a permissão de internet e o HTTP de desenvolvimento. Ao trocar a URL para HTTPS, ele volta a bloquear HTTP na próxima compilação do Unity.

## Publicar na Vercel

1. Importe este projeto na Vercel como Next.js e selecione Node.js 22/24.
2. Configure um banco **PostgreSQL persistente** e a variável `PRISMA_DATABASE_URL` com sua conexão. A API também aceita `POSTGRES_URL` e `DATABASE_URL`, nessa ordem de prioridade. Não é necessário duplicar a secret como `DATABASE_URL`: o build, as migrações e a API fazem essa adaptação automaticamente. Use uma conexão com pooling quando oferecida pelo provedor. SQLite local não deve ser usado na Vercel. Mantenha as credenciais nas variáveis da Vercel, nunca em arquivos versionados.
3. O comando de build padrão é `npm run build`; ele gera o Prisma Client PostgreSQL e compila o Next.js.
4. Antes de abrir o app aos usuários, rode `npm run db:deploy` com a `DATABASE_URL` do banco de produção. Isso aplica as migrações e cadastra os oito produtos, preservando preços que você já tiver alterado no banco. Não configure migrações concorrentes em todo preview de build.
5. Se houver um cliente WebGL/navegador, configure `ALLOWED_ORIGINS` com suas origens completas, separadas por vírgula. Android/Unity nativo não necessita dessa variável.
6. Coloque o domínio HTTPS publicado em `ApiConfig.cs` e recompile o jogo.

O banco PostgreSQL precisa ser criado pelo proprietário. Nenhum serviço externo foi provisionado ou publicado durante esta implementação. As contas de desenvolvimento no SQLite não são automaticamente copiadas para produção.

## Endpoints

Todos os caminhos abaixo são relativos a `/api/v1`. POST recebe JSON. Endpoints privados usam `Authorization: Bearer <token>`.

| Método | Caminho | Autenticação | Finalidade |
| --- | --- | --- | --- |
| GET | `/health` | Pública | Testa a API e o banco |
| POST | `/auth/register` | Pública | Cadastro e login automático |
| POST | `/auth/login` | Pública | Login por e-mail e senha |
| POST | `/auth/logout` | Privada | Revoga a sessão atual |
| GET | `/me` | Privada | Perfil, saldo, estatísticas e inventário |
| GET | `/ranking` | Pública | Top 10 real por melhor score |
| GET | `/store` | Pública | Catálogo e tamanhos dos pacotes de moedas |
| POST | `/store/purchases` | Privada | Compra booster usando moedas |
| POST | `/runs/start` | Privada | Inicia corrida identificada pelo servidor |
| POST | `/runs/checkpoint` | Privada | Sincroniza score e moedas cumulativas |
| POST | `/inventory/consume` | Privada | Consome um item durante a corrida |

Cadastro usa os campos existentes no jogo:

```json
{"name":"Meu piloto","initials":"ABC","email":"piloto@example.com","password":"senha-com-8-ou-mais","avatar":"boy"}
```

`name`: 1–16 caracteres após remover espaços externos; `initials`: três letras; `avatar`: `boy` ou `girl`; senha: 8–128 caracteres. E-mails são normalizados para minúsculas. Cadastro duplicado retorna 409. Login recebe `email` e `password`.

Cadastro e login retornam `{ "token": "...", "expiresAt": "...", "player": {...} }`, com todos os dados necessários para autenticar o piloto automaticamente. `player` inclui `id`, `name`, `initials`, `avatar`, `bestScore`, `balance`, `totalRuns`, `totalDistance`, `totalCoins` e `inventory: [{itemId, quantity}]`. `/me` retorna `{player}`. Senhas e hashes nunca entram no JSON de resposta.

Compras: `{itemId, requestId}`. Início da corrida: `{requestId}`, com retorno `{runId}`. Checkpoint: `{runId, score, coins, finished}`; score e moedas são cumulativos **dessa corrida**, não o saldo total da conta. Consumo: `{runId, itemId, requestId}`.

`requestId` contém 8–80 caracteres alfanuméricos, `_` ou `-`. Repetir o mesmo pedido devolve o resultado sem debitar novamente. O cliente gera esses identificadores; o servidor determina preços, pertencimento da corrida e saldo. As compras e o consumo são transações com isolamento serializável e repetição em caso de conflito.

## Dados e comportamento do jogo

- Usuários relacionam-se com sessões, carteira, estatísticas, corridas, inventário e histórico de compras. Inventário e compras também se relacionam com produtos; consumo se relaciona com corrida e produto.
- O cadastro substitui a simulação e já conecta a conta. A tela de entrada permite alternar para cadastro. O perfil oferece sincronização e saída da conta.
- Partidas e loja exigem uma sessão validada. A sessão é restaurada consultando a API ao abrir o jogo. Login recupera o saldo, o recorde e o inventário da conta.
- O ranking usa resultados reais. Cadastro novo começa com zero moedas e sem itens. Dados dos mocks anteriores não são enviados automaticamente ao servidor.
- Os oito boosters e seus preços, artes e durações originais foram preservados. Preço e inventário são controlados pelo servidor. O catálogo da API também alimenta as durações usadas pelo jogo.
- Pacotes de 5.000, 10.000, 25.000 e 50.000 moedas continuam “EM BREVE”, como no jogo original. Novos carros e cores também continuam futuros. Não há endpoint que entregue moedas por uma compra financeira sem pagamento validado.
- Coleta exibe saldo imediatamente; crash, perfil, loja e saída da corrida sincronizam com a API. Resultados pendentes ficam guardados por usuário e são reenviados após reconexão. Checkpoints repetidos só creditam a diferença ainda não registrada.
- A corrida permanece ativa depois da batida para permitir revive por anúncio/vida extra. Ao iniciar outra corrida ou sair da conta, a anterior é encerrada.

## Validação

Com a API local rodando:

```powershell
npm run typecheck
npm test
```

Os testes usam contas temporárias, removidas ao final, e o banco configurado em `.env`. **Execute-os somente contra o banco de testes/desenvolvimento**, pois alteram diretamente saldos das contas de teste para verificar compras.

Foi verificada a compilação de produção do Next.js, a compilação dos scripts C# e a integração HTTP no Unity. Os 10 testes da API passaram. `Assets/CruiserRush/Editor/ApiIntegrationChecks.cs` verifica cadastro/login/logout, restauração, loja e ranking; `ApiPlayChecks.cs` também verifica as telas de login/cadastro e o início e envio de uma corrida na cena real, em Play Mode.

## Limites atuais

As sessões expiram em 30 dias e o logout invalida o token no banco. Senhas usam scrypt com salt; o banco guarda apenas o hash do token de sessão. O cliente não salva senhas. O token de sessão usa PlayerPrefs nesta primeira integração; para distribuição com proteção contra extração no aparelho, substitua seu armazenamento por Android Keystore/iOS Keychain.

O servidor exige uma corrida válida, progresso cumulativo e limites de score/moedas compatíveis com o tempo decorrido. Isso evita crédito livre e duplicação, mas não substitui validação autoritativa da simulação para competição contra clientes modificados.

A proteção de tentativas de login/cadastro usa contadores persistentes. Na Vercel, usa o IP encaminhado pela plataforma; fora dela é necessário adaptar a obtenção de IP ao proxy utilizado. Limpe periodicamente sessões e contadores expirados para manutenção do banco.

Referências de implementação: [Route Handlers do Next.js](https://nextjs.org/docs/app/getting-started/route-handlers) e [relacionamentos do Prisma 6](https://docs.prisma.io/docs/orm/v6/prisma-schema/data-model/relations).


## Recompensa diária por anúncios

Migração preparada: `20261003000000_daily_ad_rewards`. Após publicar e aplicar as migrações, configurar a verificação no servidor (SSV) da unidade `ca-app-pub-8691674404508428/1406515156` com a URL `https://api-turbo-dash.vercel.app/api/v1/ads/admob/ssv`.

Apenas callbacks com assinatura Google válida contam para as cinco exibições. O quinto evento credita 5.000 moedas uma vez por dia por conta, com dia definido em `America/Fortaleza`. O cliente não decide o saldo, quantidade assistida ou data. Cada tentativa expira em dez minutos; callbacks atrasados são aceitos se o horário assinado estiver dentro da tentativa. Cancelamentos não contam, mas uma confirmação Google legítima recebida depois de um cancelamento local continua válida. O limite diário e o crédito são transacionais.

Rotas autenticadas: `GET rewards/daily`, `POST rewards/daily/start` (`requestId`), `POST rewards/daily/cancel` (`token`). Não permitir um novo anúncio enquanto `pending` for verdadeiro. A verificação `GET ads/admob/ssv` é pública e autenticada pela assinatura ECDSA.

`npm run test:rewards` prepara exclusivamente um banco SQLite em `integration-staging/daily-test.db` e testa assinatura, adulteração, cancelamento, repetição concorrente, quinto crédito, sexto anúncio bloqueado e renovação diária. Não usa o banco configurado em `.env`.
