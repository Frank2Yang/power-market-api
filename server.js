const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const csv = require('csv-parser');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 限制每个IP 15分钟内最多100个请求
  message: '请求过于频繁，请稍后再试'
});
app.use('/api/', limiter);

// 文件上传配置
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB限制
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式'), false);
    }
  }
});

// 数据验证函数
function validateData(data) {
  if (!data || data.length === 0) {
    return { valid: false, issues: ['文件为空'] };
  }

  const columns = Object.keys(data[0]);
  const timeColumns = columns.filter(col => 
    /时间|time|date|日期/i.test(col)
  );
  const priceColumns = columns.filter(col => 
    /价格|price|电价|出清/i.test(col)
  );

  const issues = [];
  if (timeColumns.length === 0) {
    issues.push('未找到时间列');
  }
  if (priceColumns.length === 0) {
    issues.push('未找到价格列');
  }

  return {
    valid: issues.length === 0,
    issues,
    timeColumns,
    priceColumns,
    rows: data.length,
    columns: columns.length,
    columnNames: columns
  };
}

// 模拟预测函数
function generatePrediction(data, hours = 24) {
  const predictions = [];
  const basePrice = 450; // 基准价格
  
  for (let i = 0; i < hours; i++) {
    const time = new Date();
    time.setHours(time.getHours() + i);
    
    // 简单的价格预测模拟
    const trend = Math.sin(i * Math.PI / 12) * 20; // 日周期
    const noise = (Math.random() - 0.5) * 10; // 随机噪声
    const price = basePrice + trend + noise;
    
    predictions.push({
      time: time.toISOString(),
      predicted_price: Math.round(price * 100) / 100,
      confidence_upper: Math.round((price + 15) * 100) / 100,
      confidence_lower: Math.round((price - 15) * 100) / 100
    });
  }
  
  return predictions;
}

// 模拟投标优化函数
function optimizeBidding(predictions, costParams = {}) {
  const { cost_g = 400, cost_up = 50, cost_dn = 30 } = costParams;
  
  // 简化的优化计算
  const avgPrice = predictions.reduce((sum, p) => sum + p.predicted_price, 0) / predictions.length;
  const optimalPrice = avgPrice * 0.95; // 略低于预测价格
  const optimalPower = 80; // MW
  const expectedRevenue = optimalPrice * optimalPower - cost_g * optimalPower;
  
  // 生成策略网格
  const priceGrid = [];
  const powerGrid = [];
  const revenueMatrix = [];
  
  for (let p = avgPrice * 0.8; p <= avgPrice * 1.2; p += (avgPrice * 0.4) / 20) {
    priceGrid.push(Math.round(p * 100) / 100);
  }
  
  for (let pow = 50; pow <= 100; pow += 2.5) {
    powerGrid.push(pow);
  }
  
  for (let i = 0; i < priceGrid.length; i++) {
    const row = [];
    for (let j = 0; j < powerGrid.length; j++) {
      const revenue = priceGrid[i] * powerGrid[j] - cost_g * powerGrid[j];
      row.push(Math.round(revenue * 100) / 100);
    }
    revenueMatrix.push(row);
  }
  
  return {
    optimal_price: Math.round(optimalPrice * 100) / 100,
    optimal_power: optimalPower,
    expected_revenue: Math.round(expectedRevenue * 100) / 100,
    price_grid: priceGrid,
    power_grid: powerGrid,
    revenue_matrix: revenueMatrix,
    cost_params: { cost_g, cost_up, cost_dn }
  };
}

// API路由

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 文件上传和数据验证
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未上传文件' });
    }

    let data;
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // 根据文件类型解析数据
    if (fileName.endsWith('.csv')) {
      // CSV文件处理
      const csvString = fileBuffer.toString('utf8');
      const lines = csvString.split('\n');
      const headers = lines[0].split(',');
      
      data = lines.slice(1, 11).map((line, index) => { // 只取前10行作为预览
        const values = line.split(',');
        const row = {};
        headers.forEach((header, i) => {
          row[header.trim()] = values[i]?.trim() || '';
        });
        return row;
      }).filter(row => Object.values(row).some(val => val !== ''));
      
    } else {
      // Excel文件处理
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);
      
      data = jsonData.slice(0, 10); // 只取前10行作为预览
    }

    // 验证数据
    const validation = validateData(data);
    
    // 准备预览数据
    const preview = data.map((row, index) => {
      const columns = Object.keys(row);
      return columns.map(col => ({
        key: `${index}-${col}`,
        column: col,
        type: isNaN(row[col]) ? '文本' : '数字',
        sample: row[col]
      }));
    }).flat().slice(0, 20); // 限制预览数据量

    res.json({
      success: true,
      data: {
        rows: data.length,
        columns: Object.keys(data[0] || {}).length,
        size: Math.round(req.file.size / 1024),
        preview: preview
      },
      validation: validation
    });

  } catch (error) {
    console.error('文件处理错误:', error);
    res.status(500).json({ error: '文件处理失败', details: error.message });
  }
});

// 预测分析
app.post('/api/predict', (req, res) => {
  try {
    const { data, config = {} } = req.body;
    const { prediction_hours = 24, models = ['rf', 'xgb', 'ensemble'] } = config;
    
    // 生成预测结果
    const predictions = generatePrediction(data, prediction_hours);
    
    // 计算性能指标
    const avgPrice = predictions.reduce((sum, p) => sum + p.predicted_price, 0) / predictions.length;
    const priceStd = Math.sqrt(
      predictions.reduce((sum, p) => sum + Math.pow(p.predicted_price - avgPrice, 2), 0) / predictions.length
    );
    
    const metrics = {
      mae: Math.round(priceStd * 0.8 * 100) / 100,
      rmse: Math.round(priceStd * 100) / 100,
      r2: 0.85 + Math.random() * 0.1,
      mape: Math.round((priceStd / avgPrice * 100) * 100) / 100
    };

    res.json({
      success: true,
      predictions: predictions,
      metrics: metrics,
      config: { prediction_hours, models },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('预测错误:', error);
    res.status(500).json({ error: '预测分析失败', details: error.message });
  }
});

// 投标优化
app.post('/api/optimize', (req, res) => {
  try {
    const { predictions, config = {} } = req.body;
    
    if (!predictions || predictions.length === 0) {
      return res.status(400).json({ error: '缺少预测数据' });
    }
    
    // 执行投标优化
    const optimization = optimizeBidding(predictions, config.cost_params);
    
    res.json({
      success: true,
      optimization: optimization,
      config: config,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('优化错误:', error);
    res.status(500).json({ error: '投标优化失败', details: error.message });
  }
});

// 错误处理中间件
app.use((error, req, res, next) => {
  console.error('服务器错误:', error);
  res.status(500).json({ 
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? error.message : '请稍后重试'
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 电力市场预测API服务器运行在端口 ${PORT}`);
  console.log(`📡 API地址: http://localhost:${PORT}/api`);
  console.log(`🏥 健康检查: http://localhost:${PORT}/api/health`);
});
