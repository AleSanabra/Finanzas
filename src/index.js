const path = require('path');
const express = require('express');
const morgan = require('morgan');
const dotenv = require('dotenv');
const indexRoutes = require('./routes');
const { initDb } = require('./config/database');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.locals.money = (value) => new Intl.NumberFormat('es-AR', {
    currency: 'ARS',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(Number(value || 0));
  res.locals.percent = (value) => new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: 1,
    style: 'percent',
  }).format(Number(value || 0));
  res.locals.date = (value) => new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`));
  next();
});

app.use('/', indexRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    message: 'No encontramos esa pagina.',
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    message: 'Algo salio mal. Revisa la consola para ver el detalle.',
  });
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Finanzas de pareja disponible en http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
