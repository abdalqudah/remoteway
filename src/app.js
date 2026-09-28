const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const { ConnectSessionKnexStore } = require('connect-session-knex');

const config = require('./config');
require('./modules/integrations/handlers'); // job types (webhooks, emails, SMS, chat)
const knex = require('./db/knex');
const { loadUser } = require('./middleware/context');
const web = require('./middleware/web');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1); // cPanel / Passenger sits behind Apache or LiteSpeed
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"], // dynamic widths for meters/charts only; scripts stay strict
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'], // lesson videos only
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use('/', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0, index: false }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // Sessions are stored in MySQL (table `sessions`), so they survive restarts and work across processes.
  app.use(session({
    name: 'rw.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new ConnectSessionKnexStore({ knex, tableName: 'sessions', createTable: true, cleanupInterval: config.isTest ? 0 : 3_600_000 }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 86_400_000 },
  }));

  // Render a view inside a layout: res.page('pages/x', { layout: 'app', ... }).
  app.use((req, res, next) => {
    res.page = (view, data = {}) => {
      const layout = data.layout || 'app';
      res.render(view, data, (err, body) => {
        if (err) return next(err);
        return res.render(`layouts/${layout}`, { ...data, body }, (err2, html) => (err2 ? next(err2) : res.send(html)));
      });
    };
    next();
  });

  app.use(loadUser);
  app.use(web.locals);
  app.use(web.csrf);

  app.get('/healthz', async (req, res) => {
    try {
      await knex.raw('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  app.use('/api/v1', require('./routes/api'));
  app.use('/', require('./routes/web'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
