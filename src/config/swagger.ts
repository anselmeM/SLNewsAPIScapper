import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Sierra Leone News API',
      version: '1.0.0',
      description: 'Aggregated news articles from Sierra Leone news outlets',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local' },
      { url: 'https://sl-news-api.onrender.com', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  },
  apis: ['src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
