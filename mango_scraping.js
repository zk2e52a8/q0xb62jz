const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealth_plugin());

// ########
// Configuración
// ########

// Los patrones son selectores CSS

const dominio_redireccion = 'https://ikigaimangas.com/';
const patron_boton_nuevo_dominio = 'div.hover\\:border-white:nth-child(1)';

// Ruta relativa de la ficha. Primer argumento
const ruta_scraping = process.argv[2];

// Título del JSON Feed. Segundo argumento
const titulo_feed = process.argv[3];

// Ruta del JSON Feed. Tercer argumento
const ruta_feed = process.argv[4];;

// El contenedor de capítulos y sus elementos internos
const patron_ficha = 'section.card.space-y-4.w-full ul.grid > li';
const patron_capitulo = 'h3.card-title.line-clamp-1';

// La URL se obtienen automáticamente desde 'href'

// ########
// Redirección
// ########

const redirigir_dominio = async (pagina) => {
	console.log('Accediendo a dominio_redireccion:', dominio_redireccion);
	await pagina.goto(dominio_redireccion, {
		waitUntil: 'load',
		timeout: 30000
	});

	console.log('Esperando a que aparezca el botón de redirección...');
	await pagina.waitForSelector(patron_boton_nuevo_dominio, {
		visible: true,
		timeout: 20000
	});

	console.log('Botón encontrado. Preparando detección de redirección...');
	const promesa_popup = new Promise(resolve => {
		pagina.once('popup', popup => {
			resolve({
				tipo: 'popup',
				popup
			});
		});
	});

	const promesa_navegacion = pagina.waitForNavigation({
		waitUntil: 'load',
		timeout: 30000
	})
	.then(response => ({
		tipo: 'navegacion',
		response
	}))
	.catch(error => ({
		tipo: 'error_navegacion',
		error
	}));

	// Disparar el clic tras definir las promesas
	await pagina.locator(patron_boton_nuevo_dominio).click();

	// Resolver la que ocurra primero: navegación o nueva pestaña
	const resultado = await Promise.race([promesa_popup, promesa_navegacion]);

	if (resultado.tipo === 'popup') {
		console.log('Nueva pestaña detectada tras redirección.');
		await resultado.popup.bringToFront();

		await pagina.close();
		console.log('Pestaña original cerrada.');

		return resultado.popup;
	}

	if (resultado.tipo === 'navegacion') {
		console.log('Redirección detectada en la misma pestaña.');
		return pagina;
	}

	console.error('Error durante la redirección:', resultado.error);
	throw new Error('Error: No se detectó redirección tras el clic.');
};

// ########
// Scraping
// ########

const procesar_paginas = async (pagina) => {
	const url_inicial = new URL(ruta_scraping, pagina.url()).href;
	console.log('URL inicial de scraping:', url_inicial);

	// Bloquear recursos multimedia
	await pagina.setRequestInterception(true);
	pagina.on('request', request => {
		const tipo_recurso = request.resourceType();
		if (['image', 'media', 'font'].includes(tipo_recurso)) {
			request.abort();
		} else {
			request.continue();
		}
	});

	const json_feed_base = { items: [] };

	// Ir a la página de fichas de capítulos
	try {
		await pagina.goto(url_inicial, {
			waitUntil: 'load',
			timeout: 30000
		});
	} catch (error) {
		console.error('Error al acceder a la página inicial de scraping:', error);
		process.exit(1);
	}

	try {
		await pagina.waitForSelector(patron_ficha, {
			timeout: 30000
		});
	} catch (error) {
		console.error('Error, no se detectó el contenedor de fichas en el tiempo esperado:', error);
		process.exit(1);
	}

	// Extraer de las fichas los capítulos y sus URLs
	const fichas = await pagina.$$eval(
		patron_ficha,
		(elementos, patron_capitulo) => {
			return elementos.map(el => {
				const elemento_capitulo = el.querySelector(patron_capitulo);
				const capitulo = elemento_capitulo ? elemento_capitulo.innerText.trim() : '';

				const elemento_a = el.querySelector('a[href]');
				const url = elemento_a ? elemento_a.href.trim() : '';

				return { capitulo, url };
			});
		},
		patron_capitulo
	).catch(error => {
		console.error('Error al extraer fichas:', error);
		return [];
	});

	if (!fichas || fichas.length === 0) {
		console.error('No se encontraron fichas en la página; revisar patron_ficha. Finalizando con error.');
		process.exit(1);
	}

	console.log(`Fichas encontradas: ${fichas.length}`);

	for (const ficha of fichas) {
		// Advertir por falta de capítulo (potencialmente causado por un selector demasiado amplio)
		if (!ficha.capitulo) {
			console.warn(`Ficha ignorada por falta de capítulo: "${ficha.capitulo}" | "${ficha.url}"`);
			continue;
		}

		// Verificar si hay URL válida
		if (!ficha.url || typeof ficha.url !== 'string' || ficha.url.trim() === '') {
			console.error(`Ficha sin una URL válida: "${ficha.capitulo}" | "${ficha.url}"`);
			process.exit(1);
		}

		// Registrar la ficha en el feed
		json_feed_base.items.push({
			id: `${titulo_feed} [${ficha.capitulo.trim()}]`,
			url: ficha.url
		});

		console.log(`Ficha: "${ficha.capitulo}" | "${ficha.url}"`);
	}

	if (!json_feed_base.items || json_feed_base.items.length === 0) {
		console.error('Ninguna ficha era válida; revisar patron_capitulo. Finalizando con error.');
		process.exit(1);
	}

	return {
		json_feed_base
	};
};


// ########
// JSON Feed
// ########

const generar_feed_final = (feed_base) => {
	// Leer feed existente si existe
	let feed_existente = { items: [] };
	try {
		if (fs.existsSync(ruta_feed)) {
			const datos = fs.readFileSync(ruta_feed, 'utf8');
			feed_existente = JSON.parse(datos);
		}
	} catch (error) {
		console.log(`Creando nuevo feed en ${ruta_feed}`);
	}

	const feed_final = {
		version: 'https://jsonfeed.org/version/1.1',
		title: titulo_feed,
		items: []
	};

	// Mapa para garantizar unicidad
	const mapa_items = new Map();

	// Procesar los nuevos items
	for (const item of (feed_base.items || [])) {
		const id_item = item.id || item.url;

		if (!mapa_items.has(id_item)) {
			mapa_items.set(id_item, {
				id: item.id,
				title: item.id,
				url: item.url
			});
		} else {
			const item_existente = mapa_items.get(id_item);
			item_existente.url = item.url;
		}
	}

	// Añadir los items del archivo al mapa
	for (const item of (feed_existente.items || [])) {
		const id_item = item.id || item.url;
		if (id_item) {
			mapa_items.set(id_item, item);
		}
	}

	// Transferir los valores del mapa al array final
	feed_final.items = Array.from(mapa_items.values());

	// Limitar a 500 items (se eliminan desde el final)
	if (feed_final.items.length > 500) {
		feed_final.items = feed_final.items.slice(0, 500);
	}

	console.log('Feed generado.');

	return feed_final;
};

// ########
// Función principal
// ########

const ejecutar_script = async () => {
	console.log('Iniciando Puppeteer.');
	const navegador = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox'] // para github actions
	});
	let pagina = await navegador.newPage();
	console.log('Página web creada.');

	// La redirección se aplica siempre en este sitio
	pagina = await redirigir_dominio(pagina, navegador);

	// Obtener URL actual y extraer sólo protocolo + dominio
	const url_actual = pagina.url();
	const dominio_limpio = (new URL(url_actual)).origin;
	console.log('Dominio limpio tras redirección:', dominio_limpio);

	// Dominio funcional para el scraping
	const dominio_funcional = dominio_limpio;
	console.log('Dominio funcional para el scraping:', dominio_funcional);

	// Ejecutar el scraping
	const { json_feed_base } = await procesar_paginas(pagina);

	// Generar el JSON Feed final en el formato deseado
	const feed_final = generar_feed_final(json_feed_base);

	// Escribir el feed en disco
	fs.writeFileSync(ruta_feed, JSON.stringify(feed_final, null, '\t'));

	// Cerrar navegador y finalizar
	await navegador.close();
	console.log('Navegador cerrado. Script finalizado.');
	setTimeout(() => {process.exit(0);}, 1000);
};

ejecutar_script();
