const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealth_plugin());

// ########
// Configuración
// ########

// Los patrones son selectores CSS

const dominio_redireccion = 'https://olympus.pages.dev/';
const patron_boton_nuevo_dominio = 'a.bg-zinc-800.hover\\:before\\:shadow-emerald-400';
const ruta_scraping = '/capitulos'; // TODO Usar otro selector css?
const patron_boton_pagina_siguiente = 'a[title="página siguiente"], a[name="página siguiente"]';

const patron_ficha = '.bg-gray-800.p-4.rounded-xl.relative'; // Contenedor del nombre, capítulo, URL y fecha
const patron_titulo = 'figcaption';
const patron_capitulo = '.flex.flex-col.gap-2.mt-4 a:first-child .chapter-name';
// La URL y fecha se obtienen automáticamente desde 'href' y 'datetime' (el primero encontrado)

const titulo_feed = 'Olympus - Nuevos capítulos';
const ruta_feed = 'olympus_feed.json';
const min_paginas = 2;
const max_paginas = 20;

const ruta_timestamp = 'olympus_timestamp.txt';

const leer_timestamp_actualizacion = () => {
	try {
		const contenido = fs.readFileSync(ruta_timestamp, 'utf8').trim();
		const timestamp = Number(contenido);

		return Number.isFinite(timestamp) ? timestamp : null;
	} catch {
		return null;
	}
};

// Si el archivo no existe, limitar a 1 día
let timestamp_actualizacion = leer_timestamp_actualizacion() ?? (Date.now() - (1 * 24 * 60 * 60 * 1000));

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
	let pagina_actual = 1;
	const umbral_timestamp = timestamp_actualizacion;
	let timestamp_reciente = umbral_timestamp;
	let fecha_ficha = null;

	// Ir a la primera página del listado
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

	// Depósito temporal para las fichas
	const json_feed_base = { items: [] };

	let continuar_scrapeo = true;

	// Entrar en la primera página antes de empezar el bucle
	try {
		await pagina.goto(url_inicial, {
			waitUntil: 'load',
			timeout: 30000
		});
	} catch (error) {
		console.error('Error al acceder a la página inicial de scraping:', error);
		process.exit(1);
	}

	while (continuar_scrapeo) {
		console.log(`\nProcesando página ${pagina_actual}...`);

		if (pagina_actual > max_paginas) {
			console.log(`Se alcanzó el límite máximo de páginas (${max_paginas}). Finalizando scraping.`);
			break;
		}

		// Espera breve para el contenido dinámico
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Extraer fichas y sus contenidos
		const fichas = await pagina.$$eval(
			patron_ficha,
			(elementos, patron_titulo, patron_capitulo) => {
				return elementos.map(el => {
					const elemento_titulo = el.querySelector(patron_titulo);
					const titulo = elemento_titulo ? elemento_titulo.innerText.trim() : '';

					const elemento_capitulo = el.querySelector(patron_capitulo);
					const capitulo = elemento_capitulo ? elemento_capitulo.innerText.trim() : '';

					const elemento_a = el.querySelector('a[href]');
					const url = elemento_a ? elemento_a.href.trim() : '';

					const elemento_time = el.querySelector('time[datetime]');
					const fecha = elemento_time ? elemento_time.getAttribute('datetime').trim() : '';

					return { titulo, url, fecha, capitulo };
				});
			},
			patron_titulo,
			patron_capitulo
		).catch(error => {
			console.error('Error al extraer fichas:', error);
			return [];
		});

		// Terminar si se llegó a la última página, o abortar si el feed está vacío
		if (!fichas || fichas.length === 0) {
			if (json_feed_base.items.length === 0) {
				console.error(`No se encontraron fichas en la página ${pagina_actual}. Finalizando con error.`);
				process.exit(1);
			} else {
				console.log(`No se encontraron fichas en la página ${pagina_actual}, finalizando el scraping.`);
				break;
			}
		}

		console.log(`Fichas encontradas en la página ${pagina_actual}: ${fichas.length}`);

		let alguna_ficha_reciente = false;
		let alguna_ficha_completa = false;

		for (const ficha of fichas) {
			const titulo = typeof ficha.titulo === 'string' ? ficha.titulo.trim() : '';
			const capitulo = typeof ficha.capitulo === 'string' ? ficha.capitulo.trim() : '';
			const url = typeof ficha.url === 'string' ? ficha.url.trim() : '';
			const fecha = typeof ficha.fecha === 'string' ? ficha.fecha.trim() : '';

			const fecha_ficha = new Date(fecha).getTime();

			const ficha_valida =
			titulo &&
			capitulo &&
			url &&
			fecha &&
			!Number.isNaN(fecha_ficha);

			if (!ficha_valida) {
				console.warn(`Ficha ignorada (datos incompletos o inválidos): "${titulo}" | "${capitulo}" | "${fecha}" | "${url}"`);
				continue;
			}

			alguna_ficha_completa = true;

			// Registrar la ficha en el feed
			json_feed_base.items.push({
				title: ficha.titulo,
				chapter: ficha.capitulo,
				url: ficha.url,
				date_published: new Date(fecha_ficha).toISOString()
			});

			if (fecha_ficha !== null && !isNaN(fecha_ficha)) {
				// Log de fichas encontradas
				if (fecha_ficha > umbral_timestamp) {
					console.log(`Ficha (NUEVA): "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
					alguna_ficha_reciente = true;
				} else {
					console.log(`Ficha: "${ficha.titulo}" | "${ficha.capitulo}" | "${ficha.fecha}" | "${ficha.url}"`);
				}

				// Actualizar timestamp
				if (fecha_ficha > timestamp_reciente) {
					timestamp_reciente = fecha_ficha;
				}
			} else {
				console.warn(`La ficha no dispone de una fecha válida: ${ficha.titulo}`);
			}
		}

		if (!alguna_ficha_completa) {
			console.error('Error: Ninguna ficha válida en la página. Posible cambio en el formato de la web. Abortando.');
			process.exit(1);
		}

		if (!alguna_ficha_reciente && pagina_actual >= min_paginas) {
			console.log('No se encontraron fichas nuevas y se ha alcanzado el mínimo de páginas. Se detiene el scraping.');
			continuar_scrapeo = false;
			break;
		}

		// Buscar botón de página siguiente
		const boton_siguiente = await pagina.$(patron_boton_pagina_siguiente);
		if (!boton_siguiente) {
			console.log('No se encontró el botón de página siguiente. Finalizando scraping.');
			break;
		}

		const boton_siguiente_habilitado = await boton_siguiente.evaluate(el => {
			return !el.classList.contains('pointer-events-none') && !el.hasAttribute('disabled');
		}).catch(() => false);

		if (!boton_siguiente_habilitado) {
			console.log('El botón de página siguiente está deshabilitado. Finalizando scraping.');
			break;
		}

		const url_anterior = pagina.url();
		const pagina_siguiente = pagina_actual + 1;

		try {
			await boton_siguiente.click();
		} catch (error) {
			console.error('Error al hacer clic en el botón de página siguiente:', error);
			break;
		}

		await pagina.waitForFunction(
			(url_prev, numero_pagina) => {
				const params = new URL(location.href).searchParams;
				return location.href !== url_prev && params.get('page') === String(numero_pagina);
			},
			{
				timeout: 30000
			},
			url_anterior,
			pagina_siguiente
		).catch(() => null);

		pagina_actual = pagina_siguiente;
	}

	return {
		json_feed_base,
		timestamp_reciente
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

	for (const item of (feed_existente.items || [])) {
		const id_item = item.id || item.title;

		if (!id_item) {
			continue;
		}

		mapa_items.set(id_item, item);
	}

	// Procesar los nuevos items
	for (const item of (feed_base.items || [])) {
		const titulo_completo = `${item.title.trim()} [${item.chapter.trim()}]`;

		if (!mapa_items.has(titulo_completo)) {

			// Item nuevo
			mapa_items.set(titulo_completo, {
				id: titulo_completo,
				title: titulo_completo,
				url: item.url,
				date_published: item.date_published
			});

		// Actualizar las URL de items duplicados
		} else {
			const item_existente = mapa_items.get(titulo_completo);

			if (item_existente.url !== item.url) {
				console.log(`URL actualizada para: ${titulo_completo}`);
				console.log(`Anterior: ${item_existente.url}`);
				console.log(`Nueva: ${item.url}`);

				item_existente.url = item.url;
			}

			// Actualizar fecha solo si existe
			if (item.date_published) {
				item_existente.date_published = item.date_published;
			}
		}
	}

	// Transferir los valores del mapa al array final
	feed_final.items = Array.from(mapa_items.values());

	// Ordenar por fecha
	feed_final.items.sort((a, b) => {
		const fecha_a = new Date(a.date_published || 0).getTime();
		const fecha_b = new Date(b.date_published || 0).getTime();

		return fecha_b - fecha_a;
	});

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
	const { json_feed_base, timestamp_reciente } = await procesar_paginas(pagina);

	// Generar el JSON Feed final en el formato deseado
	const feed_final = generar_feed_final(json_feed_base);

	// Escribir el feed y el timestamp en disco
	fs.writeFileSync(ruta_feed, JSON.stringify(feed_final, null, '\t'));
	fs.writeFileSync(ruta_timestamp, String(timestamp_reciente), 'utf8');

	// Cerrar navegador y finalizar
	await navegador.close();
	console.log('Navegador cerrado. Script finalizado.');
	setTimeout(() => {process.exit(0);}, 1000);
};

ejecutar_script();
