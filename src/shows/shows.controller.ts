import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdminOnly, Public } from '../auth/public.decorator';
import { CreateShowDto } from './dto/create-show.dto';
import { ShowStateView, ShowsService } from './shows.service';

@Controller('shows')
export class ShowsController {
  constructor(private readonly shows: ShowsService) {}

  @AdminOnly()
  @Post()
  create(@Body() dto: CreateShowDto): Promise<ShowStateView> {
    return this.shows.create(dto);
  }

  @Public()
  @Get(':id')
  getState(@Param('id') id: string): Promise<ShowStateView> {
    return this.shows.getState(id);
  }
}
