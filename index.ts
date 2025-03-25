import { PrismaClient, IdexSyncOrderStatus } from '@prisma/client';
import axios from 'axios';

// Константы
const BASE_URL = 'https://panel.gate.cx';
const BASE_DELAY = 1000;
const MAX_RETRIES = 5;
const DEFAULT_PAGES_TO_FETCH = 10;

// Инициализация Prisma клиента
const prisma = new PrismaClient();

// Типы
interface Cookie {
  domain: string;
  expirationDate: number;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  session: boolean;
  value: string;
}

interface Transaction {
  id: string | number;
  payment_method_id: string | number;
  wallet: string;
  amount: any;
  total: any;
  status: number;
  approved_at?: string;
  expired_at?: string;
  created_at: string;
  updated_at: string;
  [key: string]: any; // Для других свойств
}

/**
 * Главная функция для обработки отложенных IDEX синхронизаций
 * @returns Количество обработанных ордеров
 */
async function processPendingIdexSyncOrders(): Promise<number> {
  try {
    // Находим все ордера со статусом PENDING
    const pendingOrders = await withRetry(() => prisma.idexSyncOrder.findMany({
      where: {
        status: IdexSyncOrderStatus.PENDING
      }
    }));

    console.info(`Найдено ${pendingOrders.length} отложенных IDEX ордеров на синхронизацию`);

    for (const order of pendingOrders) {
      try {
        // Обновляем статус ордера на IN_PROGRESS
        await withRetry(() => prisma.idexSyncOrder.update({
          where: { id: order.id },
          data: {
            status: IdexSyncOrderStatus.IN_PROGRESS,
            startSyncAt: new Date()
          }
        }));

        const cabinetsToSync = await determineCabinetsToSync(order);
        const processedResults = [];

        for (const cabinet of cabinetsToSync) {
          try {
            // Определяем количество страниц для кабинета
            const pagesToFetch = determinePages(order.pages, cabinetsToSync.indexOf(cabinet));
            console.info(`Синхронизация кабинета ID ${cabinet.id} (логин: ${cabinet.login}) с ${pagesToFetch} страницами`);

            // Авторизуемся в кабинете
            const cookies = await login({
              login: cabinet.login,
              password: cabinet.password
            });

            // Получаем и сохраняем транзакции
            const transactions = await fetchTransactions(cookies, pagesToFetch, prisma);
            const savedTransactions = await saveTransactions(transactions, cabinet.id, prisma);

            // Записываем результат
            processedResults.push({
              cabinetId: cabinet.id,
              transactions: transactions.length,
              newTransactions: savedTransactions.length
            });

            console.info(`Завершена синхронизация кабинета ID ${cabinet.id}: сохранено ${savedTransactions.length} новых транзакций`);
          } catch (cabinetError) {
            console.error(`Ошибка синхронизации кабинета ID ${cabinet.id}: ${cabinetError.message}`);
            processedResults.push({
              cabinetId: cabinet.id,
              error: cabinetError.message
            });
          }
        }

        // Обновляем ордер как завершенный
        await withRetry(() => prisma.idexSyncOrder.update({
          where: { id: order.id },
          data: {
            status: IdexSyncOrderStatus.COMPLETED,
            endSyncAt: new Date(),
            processed: processedResults
          }
        }));

        console.info(`Завершен ордер синхронизации ID ${order.id}`);
      } catch (orderError) {
        console.error(`Ошибка обработки ордера синхронизации ID ${order.id}: ${orderError.message}`);
        
        // Обновляем ордер как неудачный
        await withRetry(() => prisma.idexSyncOrder.update({
          where: { id: order.id },
          data: {
            status: IdexSyncOrderStatus.FAILED,
            endSyncAt: new Date(),
            processed: { error: orderError.message }
          }
        }));
      }
    }
  } catch (error) {
    console.error(`Необработанная ошибка в processPendingIdexSyncOrders: ${error.message}`);
    return 0;
  }
  
  return pendingOrders.length;
}

/**
 * Определяет, какие кабинеты нужно синхронизировать на основе ордера
 */
async function determineCabinetsToSync(order: any) {
  if (order.cabinetId) {
    // Синхронизируем конкретный кабинет
    const cabinet = await withRetry(() => prisma.idexCabinet.findUnique({
      where: { id: order.cabinetId }
    }));
    
    if (!cabinet) {
      throw new Error(`Кабинет с ID ${order.cabinetId} не найден`);
    }
    
    return [cabinet];
  } else {
    // Синхронизируем все кабинеты
    const cabinets = await withRetry(() => prisma.idexCabinet.findMany());
    
    if (cabinets.length === 0) {
      throw new Error('В базе данных не найдено кабинетов');
    }
    
    return cabinets;
  }
}

/**
 * Определяет, сколько страниц нужно загрузить для кабинета
 */
function determinePages(pages: number[], cabinetIndex: number) {
  if (!pages || pages.length === 0) {
    return DEFAULT_PAGES_TO_FETCH; // По умолчанию используем константу
  }
  
  if (pages.length === 1) {
    return pages[0]; // Используем одно и то же количество страниц для всех кабинетов
  }
  
  // Если в массиве несколько значений, используем значение по индексу кабинета
  // Если индекс выходит за границы массива, используем последнее значение
  return pages[Math.min(cabinetIndex, pages.length - 1)];
}

/**
 * Авторизовывается в IDEX и получает куки для доступа
 * @param credentials Учетные данные для авторизации
 * @returns Куки для доступа к API IDEX
 */
async function login(credentials: { login: string; password: string }): Promise<Cookie[]> {
  const loginUrl = `${BASE_URL}/api/v1/auth/basic/login`;
  
  let retryCount = 0;
  let delay = BASE_DELAY;
  
  while (true) {
    try {
      const response = await axios.post(loginUrl, credentials);
      
      if (response.status === 200) {
        const cookies = response.headers['set-cookie'] || [];
        
        if (cookies.length === 0) {
          throw new Error('Не получены куки после авторизации');
        }
        
        const result: Cookie[] = [];
        
        for (const cookieStr of cookies) {
          const cookieParts = cookieStr.split(';')[0].split('=');
          const name = cookieParts[0];
          const value = cookieParts.slice(1).join('=');
          
          if (name === 'sid' || name === 'rsid') {
            const cookie: Cookie = {
              domain: '.panel.gate.cx',
              expirationDate: Date.now() / 1000 + 86400, // Время жизни 1 день
              hostOnly: false,
              httpOnly: true,
              name,
              path: '/',
              secure: true,
              session: false,
              value
            };
            
            result.push(cookie);
          }
        }
        
        if (result.length < 2) {
          throw new Error('Отсутствуют необходимые куки (sid и/или rsid)');
        }
        
        return result;
      } else if (response.status === 429) {
        // Слишком много запросов
        if (retryCount >= MAX_RETRIES) {
          throw new Error('Превышено максимальное количество попыток. Последний статус: 429 Too Many Requests');
        }
        
        const retryAfter = parseInt(response.headers['retry-after'] || String(delay));
        console.warn(`Ограничение скорости (429). Ожидание ${retryAfter}мс перед повторной попыткой. Попытка ${retryCount + 1}/${MAX_RETRIES}`);
        
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        
        retryCount++;
        delay *= 2; // Экспоненциальное увеличение задержки
      } else {
        throw new Error(`Авторизация не удалась со статусом: ${response.status}`);
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Обработка случая, когда axios выбрасывает ошибку вместо возврата ответа
        if (retryCount >= MAX_RETRIES) {
          throw new Error('Превышено максимальное количество попыток. Последний статус: 429 Too Many Requests');
        }
        
        const retryAfter = parseInt(error.response.headers['retry-after'] || String(delay));
        console.warn(`Ограничение скорости (429). Ожидание ${retryAfter}мс перед повторной попыткой. Попытка ${retryCount + 1}/${MAX_RETRIES}`);
        
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        
        retryCount++;
        delay *= 2; // Экспоненциальное увеличение задержки
      } else {
        throw error;
      }
    }
  }
}

/**
 * Получает страницу транзакций из IDEX API
 * @param cookies Куки для авторизации
 * @param page Номер страницы
 * @returns Массив транзакций
 */
async function fetchTransactionsPage(cookies: Cookie[], page: number): Promise<Transaction[]> {
  const cookieStr = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
  
  const transactionsUrl = `${BASE_URL}/api/v1/payments/payouts?filters%5Bstatus%5D%5B%5D=2&filters%5Bstatus%5D%5B%5D=3&filters%5Bstatus%5D%5B%5D=7&filters%5Bstatus%5D%5B%5D=8&filters%5Bstatus%5D%5B%5D=9&page=${page}`;
  
  let retryCount = 0;
  let delay = BASE_DELAY;
  
  while (true) {
    try {
      const response = await axios.get(transactionsUrl, {
        headers: {
          Cookie: cookieStr
        }
      });
      
      if (response.status === 200) {
        const json = response.data;
        
        let data;
        if (Array.isArray(json.data)) {
          data = json.data;
        } else if (json.response?.payouts?.data && Array.isArray(json.response.payouts.data)) {
          data = json.response.payouts.data;
        } else {
          throw new Error('Неожиданная структура ответа');
        }
        
        return data as Transaction[];
      } else if (response.status === 429) {
        // Слишком много запросов
        if (retryCount >= MAX_RETRIES) {
          throw new Error('Превышено максимальное количество попыток. Последний статус: 429 Too Many Requests');
        }
        
        const retryAfter = parseInt(response.headers['retry-after'] || String(delay));
        console.warn(`Ограничение скорости (429). Ожидание ${retryAfter}мс перед повторной попыткой. Попытка ${retryCount + 1}/${MAX_RETRIES}`);
        
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        
        retryCount++;
        delay *= 2; // Экспоненциальное увеличение задержки
      } else {
        throw new Error(`Не удалось получить транзакции: ${response.status}`);
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Обработка случая, когда axios выбрасывает ошибку вместо возврата ответа
        if (retryCount >= MAX_RETRIES) {
          throw new Error('Превышено максимальное количество попыток. Последний статус: 429 Too Many Requests');
        }
        
        const retryAfter = parseInt(error.response.headers['retry-after'] || String(delay));
        console.warn(`Ограничение скорости (429). Ожидание ${retryAfter}мс перед повторной попыткой. Попытка ${retryCount + 1}/${MAX_RETRIES}`);
        
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        
        retryCount++;
        delay *= 2; // Экспоненциальное увеличение задержки
      } else {
        throw error;
      }
    }
  }
}

/**
 * Получает все транзакции из IDEX API
 * @param cookies Куки для авторизации
 * @param pages Количество страниц для получения
 * @param db Экземпляр Prisma клиента
 * @returns Массив транзакций
 */
async function fetchTransactions(cookies: Cookie[], pages: number = DEFAULT_PAGES_TO_FETCH, db: any): Promise<Transaction[]> {
  const allTransactions: Transaction[] = [];
  
  for (let page = 1; page <= pages; page++) {
    console.info(`Получение страницы ${page} из ${pages}`);
    
    // Добавляем задержку между запросами страниц для предотвращения ограничения скорости
    if (page > 1) {
      await new Promise(resolve => setTimeout(resolve, BASE_DELAY));
    }
    
    try {
      const transactions = await fetchTransactionsPage(cookies, page);
      console.info(`Найдено ${transactions.length} транзакций на странице ${page}`);
      
      // Проверяем, есть ли транзакции уже в базе данных
      if (transactions.length > 0) {
        const externalIds = transactions.map(t => t.id);
        const existingTransactions = await withRetry(() => db.idexTransaction.findMany({
          where: {
            externalId: { in: externalIds }
          },
          select: { externalId: true }
        }));
        
        const existingIds = new Set(existingTransactions.map(t => t.externalId));
        const newTransactions = transactions.filter(t => !existingIds.has(t.id));
        
        console.info(`Найдено ${newTransactions.length} новых транзакций на странице ${page}`);
        allTransactions.push(...newTransactions);
        
        // Если все транзакции на странице уже есть в базе данных, прекращаем получение
        if (newTransactions.length === 0) {
          console.info(`Все транзакции на странице ${page} уже существуют в базе данных. Прекращаем получение.`);
          break;
        }
      }
      
    } catch (error) {
      console.warn(`Ошибка получения страницы ${page}: ${error}`);
      // Продолжаем со следующей страницей вместо полного прерывания
    }
  }
  
  return allTransactions;
}

/**
 * Сохраняет транзакции в базу данных
 * @param transactions Массив транзакций
 * @param cabinetId ID кабинета
 * @param db Экземпляр Prisma клиента
 */
async function saveTransactions(transactions: Transaction[], cabinetId: number, db: any): Promise<any[]> {
  // Получаем существующие транзакции для этого кабинета
  const existingTransactions = await withRetry(() => db.idexTransaction.findMany({
    where: { cabinetId },
    select: { externalId: true, cabinetId: true }
  }));

  console.info(`Найдено ${existingTransactions.length} существующих транзакций для кабинета ${cabinetId}`);
  
  // Создаем набор уникальных идентификаторов [externalId, cabinetId]
  const existingPairs = new Set(
    existingTransactions.map(t => `${t.externalId.toString()}_${t.cabinetId}`)
  );

  // Фильтруем транзакции, которые уже существуют в БД
  const newTransactions = transactions.filter(t => !existingPairs.has(`${t.id}_${cabinetId}`));
  
  if (newTransactions.length === 0) {
    console.info(`Нет новых транзакций для сохранения для кабинета ${cabinetId}`);
    return [];
  }
  
  // Сохраняем новые транзакции
  const savedTransactions = await Promise.all(
    newTransactions.map(async transaction => {
      const { id, payment_method_id, wallet, amount, total, status, approved_at, expired_at, created_at, updated_at, ...extraData } = transaction;
      
      return withRetry(() => db.idexTransaction.create({
        data: {
          externalId: BigInt(id),
          paymentMethodId: BigInt(payment_method_id),
          wallet,
          amount,
          total,
          status,
          approvedAt: approved_at ? new Date(new Date(approved_at).getTime() + 3 * 60 * 60 * 1000).toISOString() : null,
          expiredAt: expired_at ? new Date(new Date(expired_at).getTime() + 3 * 60 * 60 * 1000).toISOString() : null,
          createdAtExternal: created_at,
          updatedAtExternal: updated_at,
          extraData: extraData as any,
          cabinetId
        }
      }));
    })
  );
  
  console.info(`Сохранено ${savedTransactions.length} новых транзакций для кабинета ${cabinetId} (всего: ${existingTransactions.length + savedTransactions.length})`);
  return savedTransactions;
}

/**
 * Выполняет функцию с автоматическим повтором при ошибках подключения к базе данных
 * @param fn Функция для выполнения
 * @param retries Количество повторных попыток
 * @param delay Задержка между попытками в мс
 * @returns Результат выполнения функции
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (
      retries > 0 && 
      error?.code === 'P1001' && // Код ошибки соединения с базой данных Prisma
      error?.message?.includes("Can't reach database server")
    ) {
      console.info(`Проблема с подключением к базе данных. Повторная попытка через ${delay}мс. Осталось попыток: ${retries}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 1.5); // Увеличиваем задержку при каждой новой попытке
    }
    throw error;
  }
}

/**
 * Основной цикл проверки и обработки заданий на синхронизацию IDEX
 * @param checkInterval Интервал проверки в миллисекундах
 */
async function watchForSyncOrders(checkInterval: number = 10000) {
  console.info(`IDEX парсер запущен в режиме ожидания, проверка каждые ${checkInterval / 1000} секунд`);
  
  // Флаг для отслеживания состояния работы
  let isRunning = true;
  
  // Обработка сигналов завершения
  process.on('SIGINT', () => {
    console.info('Получен сигнал завершения SIGINT');
    isRunning = false;
    setTimeout(() => {
      console.info('Завершение работы...');
      process.exit(0);
    }, 1000);
  });
  
  process.on('SIGTERM', () => {
    console.info('Получен сигнал завершения SIGTERM');
    isRunning = false;
    setTimeout(() => {
      console.info('Завершение работы...');
      process.exit(0);
    }, 1000);
  });
  
  // Бесконечный цикл проверки и обработки
  while (isRunning) {
    try {
      // Проверяем наличие заданий со статусом PENDING
      const pendingOrders = await withRetry(() => prisma.idexSyncOrder.findMany({
        where: {
          status: IdexSyncOrderStatus.PENDING
        }
      }));
      
      if (pendingOrders.length > 0) {
        console.info(`Найдено ${pendingOrders.length} новых заданий на синхронизацию IDEX`);
        await processPendingIdexSyncOrders();
      } else {
        // Задания отсутствуют, выводим сообщение только иногда для снижения шума в логах
        const now = new Date();
        if (now.getMinutes() % 10 === 0 && now.getSeconds() < 10) {
          console.info(`[${now.toISOString()}] Ожидание новых заданий на синхронизацию IDEX...`);
        }
      }
    } catch (error) {
      console.error(`Ошибка при проверке заданий на синхронизацию: ${error.message}`);
    }
    
    // Пауза перед следующей проверкой
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  console.info('Парсер IDEX завершил работу');
  await prisma.$disconnect();
}

// Запуск бесконечного процесса отслеживания заданий
watchForSyncOrders()
  .catch(error => {
    console.error(`Критическая ошибка в работе парсера IDEX: ${error.message}`);
    process.exit(1);
  });